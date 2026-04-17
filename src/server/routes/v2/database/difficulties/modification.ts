import { Router, Request, Response } from 'express';
import { Op } from 'sequelize';
import Difficulty from '@/models/levels/Difficulty.js';
import Level from '@/models/levels/Level.js';
import Pass from '@/models/passes/Pass.js';
import Judgement from '@/models/passes/Judgement.js';
import LevelRerateHistory from '@/models/levels/LevelRerateHistory.js';
import { IDifficulty } from '@/server/interfaces/models/index.js';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  standardErrorResponses,
  standardErrorResponses400500,
  standardErrorResponses500,
  idParamSpec,
} from '@/server/schemas/v2/database/index.js';
import sequelize from '@/config/db.js';
import { getIO } from '@/misc/utils/server/socket.js';
import { sseManager } from '@/misc/utils/server/sse.js';
import { getScoreV2 } from '@/misc/utils/pass/CalcScore.js';
import { safeTransactionRollback, getFileIdFromCdnUrl, isCdnUrl } from '@/misc/utils/Utility.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  difficultyIconUpload,
  uploadDifficultyIconToCdn,
  cleanupOldDifficultyIcon,
  sendCdnErrorResponse,
  findSmallestUnoccupiedId,
  updateDifficultiesHash,
} from './shared.js';

/**
 * Difficulty CRUD, icon management, and bulk sort-order updates.
 *
 * Base-score edits are the expensive path: every pass on every level that
 * inherits the difficulty's baseScore needs its `scoreV2` recomputed. We do
 * this inside a single transaction with a batched CASE/WHEN update (500 rows
 * per statement) and then fan out an Elasticsearch reindex for the affected
 * player set once the transaction commits.
 */

const SCORE_UPDATE_BATCH_SIZE = 500;

const elasticsearchService = ElasticsearchService.getInstance();

const router: Router = Router();

router.get(
  '/',
  ApiDoc({
    operationId: 'getDifficulties',
    summary: 'List difficulties',
    description: 'Get all difficulties (for cache/list).',
    tags: ['Database', 'Difficulties'],
    responses: { 200: { description: 'Difficulties list' }, ...standardErrorResponses500 },
  }),
  async (req, res) => {
    try {
      const diffs = await Difficulty.findAll();
      const diffsList = diffs.map(diff => diff.toJSON());
      res.json(diffsList);
    } catch (error) {
      logger.error('Error fetching difficulties:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

// Bulk sort-order update lives before `POST /:id/...` and `PUT /:id`; the id
// regex wouldn't accept the literal "sort-orders" anyway, but mounting bulk
// routes first makes the matching order self-evident.
router.put(
  '/sort-orders',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'putDifficultySortOrders',
    summary: 'Update difficulty sort orders',
    description: 'Bulk update difficulty sort orders. Body: sortOrders[{ id, sortOrder }]. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    requestBody: { description: 'sortOrders', schema: { type: 'object', properties: { sortOrders: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' }, sortOrder: { type: 'number' } } } } }, required: ['sortOrders'] }, required: true },
    responses: { 200: { description: 'Sort orders updated' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const { sortOrders } = req.body;

      if (!Array.isArray(sortOrders)) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Invalid sort orders format' });
      }

      await Promise.all(
        sortOrders.map(async (item) => {
          const { id, sortOrder } = item;
          if (id === undefined || sortOrder === undefined) {
            throw new Error('Missing id or sortOrder in sort orders array');
          }

          const difficulty = await Difficulty.findByPk(id);
          if (!difficulty) {
            throw new Error(`Difficulty with ID ${id} not found`);
          }

          await difficulty.update({ sortOrder }, { transaction });
        }),
      );

      await transaction.commit();

      await updateDifficultiesHash();

      const io = getIO();
      io.emit('difficultiesReordered');

      sseManager.broadcast({
        type: 'difficultiesReordered',
        data: {
          action: 'reorder',
          count: sortOrders.length,
        },
      });

      return res.json({ message: 'Sort orders updated successfully' });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error updating sort orders:', error);
      return res.status(500).json({
        error: 'Failed to update sort orders',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/icon',
  Auth.superAdminPassword(),
  difficultyIconUpload.single('icon'),
  ApiDoc({
    operationId: 'postDifficultyIcon',
    summary: 'Upload difficulty icon',
    description: 'Upload icon for a difficulty. Multipart: icon file. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Icon uploaded' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    try {
      const diffId = parseInt(req.params.id);

      if (!req.file) {
        return res.status(400).json({ error: 'No icon file uploaded' });
      }

      const difficulty = await Difficulty.findByPk(diffId);
      if (!difficulty) {
        return res.status(404).json({ error: 'Difficulty not found' });
      }

      const oldFileId = difficulty.icon && isCdnUrl(difficulty.icon)
        ? getFileIdFromCdnUrl(difficulty.icon)
        : null;

      let newIconUrl: string;
      try {
        newIconUrl = await uploadDifficultyIconToCdn(
          req.file.buffer,
          req.file.originalname,
          difficulty.name,
          false,
        );
      } catch (uploadError) {
        return sendCdnErrorResponse(res, uploadError, 'Error uploading difficulty icon to CDN');
      }

      await difficulty.update({ icon: newIconUrl });

      await cleanupOldDifficultyIcon(oldFileId, {
        diffId,
        kind: 'icon',
        newIconUrl,
      });

      await updateDifficultiesHash();

      return res.json({
        success: true,
        icon: difficulty.icon,
      });
    } catch (error) {
      logger.error('Error uploading difficulty icon:', error);
      return res.status(500).json({ error: 'Failed to upload icon' });
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/legacy-icon',
  Auth.superAdminPassword(),
  difficultyIconUpload.single('icon'),
  ApiDoc({
    operationId: 'postDifficultyLegacyIcon',
    summary: 'Upload difficulty legacy icon',
    description: 'Upload legacy icon for a difficulty. Multipart: icon file. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Legacy icon uploaded' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    try {
      const diffId = parseInt(req.params.id);

      if (!req.file) {
        return res.status(400).json({ error: 'No icon file uploaded' });
      }

      const difficulty = await Difficulty.findByPk(diffId);
      if (!difficulty) {
        return res.status(404).json({ error: 'Difficulty not found' });
      }

      const oldFileId = difficulty.legacyIcon && isCdnUrl(difficulty.legacyIcon)
        ? getFileIdFromCdnUrl(difficulty.legacyIcon)
        : null;

      let newIconUrl: string;
      try {
        newIconUrl = await uploadDifficultyIconToCdn(
          req.file.buffer,
          req.file.originalname,
          difficulty.name,
          true,
        );
      } catch (uploadError) {
        return sendCdnErrorResponse(res, uploadError, 'Error uploading difficulty legacy icon to CDN');
      }

      await difficulty.update({ legacyIcon: newIconUrl });

      await cleanupOldDifficultyIcon(oldFileId, {
        diffId,
        kind: 'legacyIcon',
        newIconUrl,
      });

      await updateDifficultiesHash();

      return res.json({
        success: true,
        legacyIcon: difficulty.legacyIcon,
      });
    } catch (error) {
      logger.error('Error uploading difficulty legacy icon:', error);
      return res.status(500).json({ error: 'Failed to upload legacy icon' });
    }
  },
);

router.post(
  '/',
  Auth.superAdminPassword(),
  difficultyIconUpload.fields([
    { name: 'icon', maxCount: 1 },
    { name: 'legacyIcon', maxCount: 1 },
  ]),
  ApiDoc({
    operationId: 'postDifficulty',
    summary: 'Create difficulty',
    description: 'Create a difficulty. Body: id?, name, type, icon?, emoji?, color?, baseScore?, legacy?, legacyIcon?, legacyEmoji?. Multipart: icon, legacyIcon. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    requestBody: { description: 'id, name, type, icon, emoji, color, baseScore, legacy, legacyIcon, legacyEmoji', schema: { type: 'object', properties: { id: { type: 'number' }, name: { type: 'string' }, type: { type: 'string' }, icon: { type: 'string' }, emoji: { type: 'string' }, color: { type: 'string' }, baseScore: { type: 'number' }, legacy: { type: 'boolean' }, legacyIcon: { type: 'string' }, legacyEmoji: { type: 'string' } }, required: ['name'] }, required: true },
    responses: { 201: { description: 'Difficulty created' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const {
        id,
        name,
        type,
        icon,
        emoji,
        color,
        baseScore,
        legacy,
        legacyIcon,
        legacyEmoji,
      } = req.body;

      let difficultyId: number;
      if (id !== undefined && id !== null && id !== '') {
        const existingDiffId = await Difficulty.findByPk(parseInt(id));
        if (existingDiffId) {
          return res
            .status(400)
            .json({ error: 'A difficulty with this ID already exists' });
        }
        difficultyId = parseInt(id);
      } else {
        difficultyId = await findSmallestUnoccupiedId();
      }

      const existingDiffName = await Difficulty.findOne({ where: { name } });
      if (existingDiffName) {
        return res
          .status(400)
          .json({ error: 'A difficulty with this name already exists' });
      }

      // Icon resolution priority (applies independently to primary + legacy):
      //   1. Attached file → upload to CDN
      //   2. Explicit null → no icon
      //   3. String URL → store verbatim
      let finalIcon: string | null = null;
      let finalLegacyIcon: string | null = null;
      const iconFile = (req.files as { [fieldname: string]: Express.Multer.File[] })?.['icon']?.[0];
      const legacyIconFile = (req.files as { [fieldname: string]: Express.Multer.File[] })?.['legacyIcon']?.[0];

      if (iconFile) {
        try {
          finalIcon = await uploadDifficultyIconToCdn(iconFile.buffer, iconFile.originalname, name, false);
        } catch (uploadError) {
          return sendCdnErrorResponse(res, uploadError, 'Error uploading difficulty icon to CDN');
        }
      } else if (icon === 'null' || icon === null) {
        finalIcon = null;
      } else if (icon && typeof icon === 'string') {
        finalIcon = icon;
      }

      if (legacyIconFile) {
        try {
          finalLegacyIcon = await uploadDifficultyIconToCdn(legacyIconFile.buffer, legacyIconFile.originalname, name, true);
        } catch (uploadError) {
          return sendCdnErrorResponse(res, uploadError, 'Error uploading difficulty legacy icon to CDN');
        }
      } else if (legacyIcon === 'null' || legacyIcon === null) {
        finalLegacyIcon = null;
      } else if (legacyIcon && typeof legacyIcon === 'string') {
        finalLegacyIcon = legacyIcon;
      }

      const lastSortOrder = await Difficulty.max('sortOrder') as number;

      const difficulty = await Difficulty.create({
        id: difficultyId,
        name,
        type,
        icon: finalIcon,
        emoji,
        color,
        baseScore,
        legacy,
        legacyIcon: finalLegacyIcon,
        legacyEmoji,
        sortOrder: lastSortOrder + 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as IDifficulty);

      await updateDifficultiesHash();

      return res.status(201).json(difficulty);
    } catch (error) {
      logger.error('Error creating difficulty:', error);
      return res.status(500).json({ error: 'Failed to create difficulty' });
    }
  },
);

router.put(
  '/:id([0-9]{1,20})',
  Auth.superAdminPassword(),
  difficultyIconUpload.fields([
    { name: 'icon', maxCount: 1 },
    { name: 'legacyIcon', maxCount: 1 },
  ]),
  ApiDoc({
    operationId: 'putDifficulty',
    summary: 'Update difficulty',
    description: 'Update a difficulty. Body: name?, type?, icon?, emoji?, color?, baseScore?, sortOrder?, legacy?, legacyIcon?, legacyEmoji?. Multipart: icon, legacyIcon. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: { description: 'name, type, icon, emoji, color, baseScore, sortOrder, legacy, legacyIcon, legacyEmoji', schema: { type: 'object' }, required: true },
    responses: { 200: { description: 'Difficulty updated' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const diffId = parseInt(req.params.id);
      const {
        name,
        type,
        icon,
        emoji,
        color,
        baseScore,
        sortOrder,
        legacy,
        legacyIcon,
        legacyEmoji,
      } = req.body;

      const difficulty = await Difficulty.findByPk(diffId);
      if (!difficulty) {
        await safeTransactionRollback(transaction);
        return res.status(404).json({ error: 'Difficulty not found' });
      }

      if (name && name !== difficulty.name) {
        const existingDiffName = await Difficulty.findOne({ where: { name } });
        if (existingDiffName) {
          await safeTransactionRollback(transaction);
          return res
            .status(400)
            .json({ error: 'A difficulty with this name already exists' });
        }
      }

      // Icon update priority (same as on tags):
      //   1. Attached file → upload and mark old for post-commit cleanup
      //   2. Explicit null → clear the field and mark old for cleanup
      //   3. String URL (different from current) → store verbatim
      //   4. Anything else → don't touch the field (leave finalIcon undefined)
      const iconFile = (req.files as { [fieldname: string]: Express.Multer.File[] })?.['icon']?.[0];
      const legacyIconFile = (req.files as { [fieldname: string]: Express.Multer.File[] })?.['legacyIcon']?.[0];

      let finalIcon: string | null | undefined = undefined;
      let finalLegacyIcon: string | null | undefined = undefined;
      let oldIconFileId: string | null = null;
      let oldLegacyIconFileId: string | null = null;

      if (iconFile) {
        if (difficulty.icon && isCdnUrl(difficulty.icon)) {
          oldIconFileId = getFileIdFromCdnUrl(difficulty.icon);
        }
        try {
          finalIcon = await uploadDifficultyIconToCdn(
            iconFile.buffer,
            iconFile.originalname,
            name || difficulty.name,
            false,
          );
        } catch (uploadError) {
          await safeTransactionRollback(transaction);
          return sendCdnErrorResponse(res, uploadError, 'Error uploading difficulty icon to CDN');
        }
      } else if (icon === 'null' || icon === null) {
        if (difficulty.icon && isCdnUrl(difficulty.icon)) {
          oldIconFileId = getFileIdFromCdnUrl(difficulty.icon);
        }
        finalIcon = null;
      } else if (icon && icon !== difficulty.icon && typeof icon === 'string') {
        finalIcon = icon;
      }

      if (legacyIconFile) {
        if (difficulty.legacyIcon && isCdnUrl(difficulty.legacyIcon)) {
          oldLegacyIconFileId = getFileIdFromCdnUrl(difficulty.legacyIcon);
        }
        try {
          finalLegacyIcon = await uploadDifficultyIconToCdn(
            legacyIconFile.buffer,
            legacyIconFile.originalname,
            name || difficulty.name,
            true,
          );
        } catch (uploadError) {
          await safeTransactionRollback(transaction);
          return sendCdnErrorResponse(res, uploadError, 'Error uploading difficulty legacy icon to CDN');
        }
      } else if (legacyIcon === 'null' || legacyIcon === null) {
        if (difficulty.legacyIcon && isCdnUrl(difficulty.legacyIcon)) {
          oldLegacyIconFileId = getFileIdFromCdnUrl(difficulty.legacyIcon);
        }
        finalLegacyIcon = null;
      } else if (legacyIcon && legacyIcon !== difficulty.legacyIcon && typeof legacyIcon === 'string') {
        finalLegacyIcon = legacyIcon;
      }

      const isBaseScoreChanged =
        baseScore !== undefined && baseScore !== difficulty.baseScore;

      // Only touch icon fields that explicitly changed, so a PUT that only
      // flips `emoji` doesn't wipe a CDN-hosted icon.
      const updateData: Partial<IDifficulty> = {
        name: name ?? difficulty.name,
        type: type ?? difficulty.type,
        emoji: emoji ?? difficulty.emoji,
        color: color ?? difficulty.color,
        baseScore: baseScore ?? difficulty.baseScore,
        sortOrder: sortOrder ?? difficulty.sortOrder,
        legacy: legacy ?? difficulty.legacy,
        legacyEmoji: legacyEmoji ?? difficulty.legacyEmoji,
        updatedAt: new Date(),
      };

      if (finalIcon !== undefined) {
        updateData.icon = finalIcon as any;
      }
      if (finalLegacyIcon !== undefined) {
        updateData.legacyIcon = finalLegacyIcon as any;
      }

      await difficulty.update(updateData, { transaction });

      let affectedPassCount = 0;
      const affectedPlayerIds: Set<number> = new Set();

      if (isBaseScoreChanged) {
        // Only levels that *inherit* the difficulty baseScore are affected —
        // levels with an explicit non-zero baseScore aren't tied to the
        // difficulty's base value, so their scoreV2 remains correct as-is.
        const levels = await Level.findAll({
          attributes: ['id', 'baseScore', 'ppBaseScore'],
          where: {
            diffId: diffId,
            [Op.or]: [
              { baseScore: null },
              { baseScore: 0 },
            ],
          },
          transaction,
        });

        const levelIds = levels.map(level => level.id);

        if (levelIds.length > 0) {
          const levelDataMap = new Map(
            levels.map(level => [level.id, {
              baseScore: level.baseScore,
              ppBaseScore: level.ppBaseScore,
            }]),
          );

          const updatedDifficulty = {
            name: updateData.name as string,
            baseScore: updateData.baseScore as number,
          };

          const affectedPasses = await Pass.findAll({
            attributes: ['id', 'speed', 'isNoHoldTap', 'playerId', 'levelId', 'scoreV2'],
            where: {
              levelId: { [Op.in]: levelIds },
              isDeleted: false,
            },
            include: [
              {
                model: Judgement,
                as: 'judgements',
              },
            ],
            transaction,
          });

          const scoreUpdates: { id: number; scoreV2: number }[] = [];

          for (const pass of affectedPasses) {
            if (!pass.judgements) continue;

            const level = levelDataMap.get(pass.levelId);
            if (!level) continue;

            const levelData = {
              baseScore: level.baseScore,
              ppBaseScore: level.ppBaseScore,
              difficulty: updatedDifficulty,
            };

            const passData = {
              speed: pass.speed || 1.0,
              judgements: pass.judgements,
              isNoHoldTap: pass.isNoHoldTap || false,
            };

            const newScore = getScoreV2(passData, levelData);
            scoreUpdates.push({ id: pass.id, scoreV2: newScore });

            if (pass.playerId) {
              affectedPlayerIds.add(pass.playerId);
            }
          }

          // Batch with CASE/WHEN — one query per chunk, beats N individual
          // UPDATEs by a wide margin at realistic pass counts.
          for (let i = 0; i < scoreUpdates.length; i += SCORE_UPDATE_BATCH_SIZE) {
            const batch = scoreUpdates.slice(i, i + SCORE_UPDATE_BATCH_SIZE);
            const ids = batch.map(u => u.id);
            const cases = batch.map(u => `WHEN ${u.id} THEN ${u.scoreV2}`).join(' ');

            await sequelize.query(
              `UPDATE passes SET scoreV2 = CASE id ${cases} END WHERE id IN (${ids.join(',')})`,
              { transaction },
            );
          }

          affectedPassCount = scoreUpdates.length;
        }
      }

      await transaction.commit();

      // CDN cleanup runs post-commit so a cleanup failure never rolls back
      // the already-committed difficulty update.
      if (finalIcon !== undefined) {
        await cleanupOldDifficultyIcon(oldIconFileId, {
          diffId,
          kind: 'icon',
          newIconUrl: finalIcon,
        });
      }
      if (finalLegacyIcon !== undefined) {
        await cleanupOldDifficultyIcon(oldLegacyIconFileId, {
          diffId,
          kind: 'legacyIcon',
          newIconUrl: finalLegacyIcon,
        });
      }

      if (isBaseScoreChanged && affectedPlayerIds.size > 0) {
        try {
          // Reindex affected players in ES; ranks are recomputed at read time
          // so no extra rank-update pass is required.
          await elasticsearchService.reindexPlayers(Array.from(affectedPlayerIds));

          const io = getIO();
          io.emit('leaderboardUpdated');
          io.emit('difficultyUpdated', { difficultyId: diffId });

          sseManager.broadcast({
            type: 'difficultyUpdate',
            data: {
              difficultyId: diffId,
              action: 'update',
              affectedPasses: affectedPassCount,
              affectedPlayers: affectedPlayerIds.size,
            },
          });
        } catch (error) {
          logger.error('Error updating player stats:', error);
          return res.status(500).json({
            error:
              'Difficulty updated but failed to reload stats. Please reload manually.',
            details: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        const io = getIO();
        io.emit('difficultyUpdated', { difficultyId: diffId });

        sseManager.broadcast({
          type: 'difficultyUpdate',
          data: {
            difficultyId: diffId,
            action: 'update',
            affectedPasses: 0,
            affectedPlayers: 0,
          },
        });
      }

      await updateDifficultiesHash();

      return res.json(difficulty);
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error updating difficulty:', error);
      return res.status(500).json({ error: 'Failed to update difficulty' });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'deleteDifficulty',
    summary: 'Delete difficulty',
    description: 'Mark difficulty as LEGACY and migrate levels to fallback. Query: fallbackId. Super admin password.',
    tags: ['Database', 'Difficulties'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    query: { fallbackId: { schema: { type: 'string' } } },
    responses: { 200: { description: 'Difficulty marked LEGACY' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    try {
      const diffId = parseInt(req.params.id);
      const fallbackDiffId = parseInt(req.query.fallbackId as string);

      if (fallbackDiffId === undefined || fallbackDiffId === null) {
        return res
          .status(400)
          .json({ error: 'Fallback difficulty ID is required' });
      }

      const difficulty = await Difficulty.findByPk(diffId);
      if (!difficulty) {
        return res.status(404).json({ error: 'Difficulty to delete not found' });
      }

      const fallbackDifficulty = await Difficulty.findByPk(fallbackDiffId);
      if (!fallbackDifficulty) {
        return res.status(404).json({ error: 'Fallback difficulty not found' });
      }

      if (diffId === fallbackDiffId) {
        return res.status(400).json({
          error:
            'Fallback difficulty cannot be the same as the difficulty to delete',
        });
      }

      let transaction: any;

      try {
        transaction = await sequelize.transaction();
        // Migrate every level off the doomed difficulty before we touch the
        // difficulty itself, so constraint checks never see a dangling row.
        const affectedLevels = await Level.findAll({
          where: { diffId: diffId },
          transaction,
        });
        await Level.update(
          { diffId: fallbackDiffId },
          {
            where: { diffId: diffId },
            transaction,
            individualHooks: true,
          },
        );

        for (const level of affectedLevels) {
          await LevelRerateHistory.create({
            levelId: level.id,
            previousDiffId: diffId,
            newDiffId: fallbackDiffId,
            previousBaseScore: level.baseScore || difficulty.baseScore,
            newBaseScore: level.baseScore || fallbackDifficulty.baseScore,
            reratedBy: req.user?.id || null,
            createdAt: new Date(),
          }, { transaction });
        }

        // Mark LEGACY instead of hard-deleting so historical data (rerate
        // history, old passes, cached responses) still resolves the row.
        await difficulty.update({ type: 'LEGACY' as any }, { transaction });

        await transaction.commit();

        await updateDifficultiesHash();

        return res.json({
          message: 'Difficulty marked as LEGACY',
          updatedLevels: await Level.count({ where: { diffId: fallbackDiffId } }),
        });
      } catch (error) {
        logger.error('Error deleting difficulty:', error);
        await safeTransactionRollback(transaction);
        throw error;
      }
    } catch (error) {
      logger.error('Error deleting difficulty:', error);
      return res.status(500).json({ error: 'Failed to delete difficulty' });
    }
  },
);

export default router;
