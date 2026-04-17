import {Router, Request, Response, NextFunction} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import { errorResponseSchema, docRequestBody, standardErrorResponses, standardErrorResponses400500, standardErrorResponses403404500, standardErrorResponses404500, standardErrorResponses500, stringIdParamSpec } from '@/server/schemas/v2/admin/index.js';
import {Op, QueryTypes} from 'sequelize';
import { getFileIdFromCdnUrl, isCdnUrl, safeTransactionRollback } from '@/misc/utils/Utility.js';
import { multerMemoryCdnImage10Mb as upload } from '@/config/multerMemoryUploads.js';
import CdnService from '@/server/services/core/CdnService.js';
import Curation from '@/models/curations/Curation.js';
import CurationCurationType from '@/models/curations/CurationCurationType.js';
import CurationType from '@/models/curations/CurationType.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Level from '@/models/levels/Level.js';
import CurationSchedule from '@/models/curations/CurationSchedule.js';
import Creator from '@/models/credits/Creator.js';
import { logger } from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import sequelize from '@/config/db.js';
import { hasAnyFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags, curationTypeAbilities } from '@/config/constants.js';
import { canAssignCurationType, hasAbility } from '@/misc/utils/data/curationTypeUtils.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Team from '@/models/credits/Team.js';
import { roleSyncService } from '@/server/services/accounts/RoleSyncService.js';
import { PaginationQuery } from '@/server/interfaces/models/index.js';
import { updateDifficultiesHash } from '@/server/routes/v2/database/difficulties/index.js';
import { getIO } from '@/misc/utils/server/socket.js';
import { sseManager } from '@/misc/utils/server/sse.js';
import { serializeCurationJson, sortCurationsByTypeOrder } from '@/misc/utils/data/curationOrdering.js';
import { parseFacetQueryString } from '@/misc/utils/search/facetQuery.js';
import {
  levelIdsForCurationFacetDomain,
  mergeFacetLevelIds,
} from '@/misc/utils/search/facetQueryCurationSql.js';
import { CacheInvalidation } from '@/server/middleware/cache.js';

const router: Router = Router();

const elasticsearchService = ElasticsearchService.getInstance();

// Middleware to verify curation management permissions
const requireCurationPermission = (req: Request, res: Response, next: NextFunction) => {
  const { id } = req.params;

  // Super admins can manage all curations
  if (hasAnyFlag(req.user, [permissionFlags.SUPER_ADMIN, permissionFlags.HEAD_CURATOR])) {
    return next();
  }

  // Regular curators and raters need to check if they can assign the curation type
  if (hasAnyFlag(req.user, [permissionFlags.CURATOR, permissionFlags.RATER])) {
    return Curation.findByPk(id, {
      include: [{ model: CurationType, as: 'types', through: { attributes: [] } }],
    }).then((curation) => {
      if (!curation) {
        return res.status(404).json({error: 'Curation not found'});
      }

      const types = curation.types || [];
      const flags = BigInt(req.user?.permissionFlags || 0);
      if (types.length === 0) {
        return next();
      }
      for (const t of types) {
        if (!canAssignCurationType(flags, BigInt(t.abilities))) {
          return res.status(403).json({error: 'You do not have permission to manage this curation'});
        }
      }

      return next();
    }).catch((error) => {
      logger.error('Error checking curation permission:', error);
      return res.status(500).json({error: 'Internal server error'});
    });
  }

  return res.status(403).json({error: 'You do not have permission to manage curations'});
};

const requireCurationManagementPermission = (req: Request, res: Response, next: NextFunction) => {
  return Auth.user()(req, res, (err) => {
    if (err) return next(err);
    return requireCurationPermission(req, res, next);
  });
};

// Middleware to verify curation creation permissions (for POST requests)
const requireCurationCreationPermission = (req: Request, res: Response, next: NextFunction) => {
  // Super admins and head curators can create all curations
  if (hasAnyFlag(req.user, [permissionFlags.SUPER_ADMIN, permissionFlags.HEAD_CURATOR])) {
    return next();
  }

  // Regular curators and raters can create curations
  if (hasAnyFlag(req.user, [permissionFlags.CURATOR, permissionFlags.RATER])) {
    return next();
  }

  return res.status(403).json({error: 'You do not have permission to create curations'});
};

// Combined authentication and permission middleware for curator OR rater
const requireCuratorOrRater = (req: Request, res: Response, next: NextFunction) => {
  // First run base authentication
  return Auth.user()(req, res, (err) => {
    if (err) return next(err);

    // Then check permissions
    return requireCurationCreationPermission(req, res, next);
  });
};

// Helper function to clean up CDN files for curations
const cleanupCurationCdnFiles = async (curations: Curation[]) => {
  for (const curation of curations) {
    // Clean up curation thumbnail if it exists
    if (curation.previewLink && isCdnUrl(curation.previewLink)) {
      const fileId = getFileIdFromCdnUrl(curation.previewLink);
      if (fileId) {
        try {
          logger.debug(`Deleting curation thumbnail ${fileId} from CDN`);
          await CdnService.deleteFile(fileId);
          logger.debug(`Successfully deleted curation thumbnail ${fileId} from CDN`);
        } catch (error) {
          logger.error(`Error deleting curation thumbnail ${fileId} from CDN:`, error);
          // Continue with cleanup even if CDN deletion fails
        }
      }
    }
  }
};

// Helper function to clean up CDN files for curation types
const cleanupCurationTypeCdnFiles = async (type: CurationType) => {
  // Clean up curation type icon if it exists
  if (type.icon && isCdnUrl(type.icon)) {
    const fileId = getFileIdFromCdnUrl(type.icon);
    if (fileId) {
      try {
        logger.debug(`Deleting curation type icon ${fileId} from CDN`);
        await CdnService.deleteFile(fileId);
        logger.debug(`Successfully deleted curation type icon ${fileId} from CDN`);
      } catch (error) {
        logger.error(`Error deleting curation type icon ${fileId} from CDN:`, error);
        // Continue with cleanup even if CDN deletion fails
      }
    }
  }
};

const syncRolesForLevel = async (
  levelId: number | undefined,
  oldCurationTypeSets?: Map<number, Set<number>>
) => {
  if (!levelId) {
    return;
  }

  const level = await Level.findByPk(levelId, {
    include: [
      {
        model: LevelCredit,
        as: 'levelCredits',
        include: [{
          model: Creator,
          as: 'creator',
        }],
      },
    ],
  });

  if (!level?.levelCredits) {
    return;
  }

  const creatorIds = level.levelCredits
    .map(credit => credit.creator?.id)
    .filter((id): id is number => id !== null && id !== undefined);

  if (creatorIds.length === 0) {
    return;
  }

  // If old curation type sets are provided, perform change detection
  if (oldCurationTypeSets) {
    // Get new curation type sets (after change)
    const newCurationTypeSets = await roleSyncService.getCreatorsCurationTypeSets(creatorIds);

    // Find creators whose curation type set changed
    const changedCreatorIds = creatorIds.filter(creatorId => {
      const oldTypes = oldCurationTypeSets.get(creatorId) ?? new Set<number>();
      const newTypes = newCurationTypeSets.get(creatorId) ?? new Set<number>();

      // Compare sets - if sizes differ or sets are not equal, there's a change
      if (oldTypes.size !== newTypes.size) {
        return true;
      }

      // Check if all types in old set exist in new set
      for (const typeId of oldTypes) {
        if (!newTypes.has(typeId)) {
          return true; // Type was removed
        }
      }

      // Check if any new types were added
      for (const typeId of newTypes) {
        if (!oldTypes.has(typeId)) {
          return true; // Type was added
        }
      }

      return false; // Sets are identical
    });

    // Only notify changed creators
    if (changedCreatorIds.length > 0) {
      logger.debug(`[curations] Curation type sets changed for ${changedCreatorIds.length} creator(s) out of ${creatorIds.length}`);
      await roleSyncService.notifyBotOfRoleSyncByCreatorIds(changedCreatorIds);
    } else {
      logger.debug(`[curations] No curation type set changes detected for ${creatorIds.length} creator(s)`);
    }
  } else {
    // No old state provided, notify all creators (backward compatibility for create case)
    // For create, we still want to notify since it's a new curation
    await roleSyncService.notifyBotOfRoleSyncByCreatorIds(creatorIds);
  }
};


// Get all curation types
router.get(
  '/types',
  ApiDoc({
    operationId: 'getAdminCurationTypes',
    summary: 'List curation types',
    description: 'List all curation types ordered by sortOrder and name.',
    tags: ['Admin', 'Curations'],
    responses: { 200: { description: 'Curation types' }, ...standardErrorResponses500 },
  }),
  async (req, res) => {
  try {
    const types = await CurationType.findAll({
      order: [['groupSortOrder', 'ASC'], ['sortOrder', 'ASC'], ['name', 'ASC']],
    });

    // Convert BigInt abilities to string for JSON serialization
    const serializedTypes = types.map(type => ({
      ...type.toJSON(),
      abilities: type.abilities.toString()
    }));

    return res.json(serializedTypes);
  } catch (error) {
    logger.error('Error fetching curation types:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
  }
);

// Create curation type
router.post(
  '/types',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'postAdminCurationType',
    summary: 'Create curation type',
    description: 'Create a curation type. Body: name, color?, abilities?. Super admin password.',
    tags: ['Admin', 'Curations'],
    security: ['bearerAuth'],
    requestBody: { description: 'name, color, abilities', schema: { type: 'object', properties: { name: { type: 'string' }, color: { type: 'string' }, abilities: { type: 'string' } }, required: ['name'] }, required: true },
    responses: { 201: { description: 'Curation type created' }, ...standardErrorResponses400500, 409: { schema: errorResponseSchema } },
  }),
  async (req, res) => {
  try {
    const {name, color, abilities, group} = req.body;

    if (!name) {
      return res.status(400).json({error: 'Name is required'});
    }

    // Check for duplicate name (case-insensitive)
    const existingType = await CurationType.findOne({
      where: sequelize.where(
        sequelize.fn('LOWER', sequelize.col('name')),
        '=',
        name.trim().toLowerCase()
      )
    });

    if (existingType) {
      return res.status(409).json({error: 'A curation type with this name already exists'});
    }

    const groupVal =
      group !== undefined && group !== null ? String(group).trim() : '';
    const type = await CurationType.create({
      name: name.trim(),
      color: color || '#ffffff',
      abilities: abilities ? BigInt(abilities) : 0n,
      sortOrder: 0,
      group: groupVal === '' ? null : groupVal,
      groupSortOrder: 0,
    });

    // Convert BigInt abilities to string for JSON serialization
    const serializedType = {
      ...type.toJSON(),
      abilities: type.abilities.toString()
    };

    await updateDifficultiesHash();

    return res.status(201).json(serializedType);
  } catch (error) {
    logger.error('Error creating curation type:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
  }
);

// Update curation type
router.put(
  '/types/:id([0-9]{1,20})',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'putAdminCurationType',
    summary: 'Update curation type',
    description: 'Update curation type by id. Body: name?, color?, abilities?. Super admin password.',
    tags: ['Admin', 'Curations'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    requestBody: { description: 'name, color, abilities', schema: { type: 'object' }, required: true },
    responses: { 200: { description: 'Curation type updated' }, ...standardErrorResponses404500, 409: { schema: errorResponseSchema } },
  }),
  async (req, res) => {
  try {
    const {id} = req.params;
    const {name, color, abilities, group} = req.body;

    const type = await CurationType.findByPk(id);
    if (!type) {
      return res.status(404).json({error: 'Curation type not found'});
    }

    // Check for duplicate name (case-insensitive) if name is being updated
    if (name && name !== type.name) {
      const existingType = await CurationType.findOne({
        where: {
          [Op.and]: [
            sequelize.where(
              sequelize.fn('LOWER', sequelize.col('name')),
              '=',
              name.trim().toLowerCase()
            ),
            {
              id: {
                [Op.ne]: id // Exclude current type from check
              }
            }
          ]
        }
      });

      if (existingType) {
        return res.status(409).json({error: 'A curation type with this name already exists'});
      }
    }

    await type.update({
      name: name ? name.trim() : type.name,
      color,
      abilities: abilities ? BigInt(abilities) : type.abilities,
      ...(group !== undefined
        ? { group: String(group).trim() === '' ? null : String(group).trim() }
        : {}),
    });

    // Convert BigInt abilities to string for JSON serialization
    const serializedType = {
      ...type.toJSON(),
      abilities: type.abilities.toString()
    };

    await updateDifficultiesHash();

    return res.json(serializedType);
  } catch (error) {
    logger.error('Error updating curation type:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
  }
);

// Delete curation type
router.delete(
  '/types/:id([0-9]{1,20})',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'deleteAdminCurationType',
    summary: 'Delete curation type',
    description: 'Delete curation type and cascade delete related curations. Super admin password.',
    tags: ['Admin', 'Curations'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 204: { description: 'Curation type deleted' }, ...standardErrorResponses404500 },
  }),
  async (req, res) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const {id} = req.params;

    const type = await CurationType.findByPk(id, { transaction });
    if (!type) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Curation type not found'});
    }

    const levelRows = await sequelize.query<{ levelId: number }>(
      `SELECT DISTINCT c.levelId FROM curations c
       INNER JOIN curation_curation_types cct ON cct.curationId = c.id
       WHERE cct.typeId = :typeId`,
      { replacements: { typeId: id }, type: QueryTypes.SELECT, transaction }
    );
    const affectedLevelIds = levelRows.map((r) => r.levelId);

    await cleanupCurationTypeCdnFiles(type);

    await type.destroy({ transaction });

    await transaction.commit();

    await updateDifficultiesHash();

    // Reindex affected levels after successful deletion
    await elasticsearchService.reindexLevels(affectedLevelIds);

    logger.debug(`Successfully deleted curation type ${id}; reindexing ${affectedLevelIds.length} level(s)`);
    return res.status(204).end();
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error deleting curation type:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
  }
);

// Upload curation icon
router.post(
  '/types/:id([0-9]{1,20})/icon',
  Auth.superAdminPassword(),
  upload.single('icon'),
  ApiDoc({
    operationId: 'postAdminCurationTypeIcon',
    summary: 'Upload curation type icon',
    description: 'Upload icon for curation type. Super admin password.',
    tags: ['Admin', 'Curations'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    requestBody: { description: 'multipart/form-data with icon file', schema: { type: 'object' }, required: true },
    responses: { 200: { description: 'Icon uploaded' }, ...standardErrorResponses },
  }),
  async (req, res) => {
  try {
    const {id} = req.params;

    if (!req.file) {
      return res.status(400).json({error: 'No icon file uploaded'});
    }

    const type = await CurationType.findByPk(id);
    if (!type) {
      return res.status(404).json({error: 'Curation type not found'});
    }

    // Upload to CDN
    const filename = `curation_icon_${id}_${Date.now()}.${req.file.originalname.split('.').pop()}`;
    const cdnResult = await CdnService.uploadCurationIcon(req.file.buffer, filename);

    // Update curation type with icon URL
    await type.update({
      icon: cdnResult.urls.original || cdnResult.urls.medium
    });

    await updateDifficultiesHash();

    return res.json({
      success: true,
      icon: type.icon,
      cdnData: cdnResult
    });
  } catch (error) {
    logger.error('Error uploading curation icon:', error);
    return res.status(500).json({error: 'Failed to upload icon'});
  }
  }
);

// Delete curation icon
router.delete(
  '/types/:id([0-9]{1,20})/icon',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'deleteAdminCurationTypeIcon',
    summary: 'Delete curation type icon',
    description: 'Remove icon from curation type. Super admin password.',
    tags: ['Admin', 'Curations'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 200: { description: 'Icon removed' }, ...standardErrorResponses404500 },
  }),
  async (req, res) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const {id} = req.params;

    const type = await CurationType.findByPk(id, { transaction });
    if (!type) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Curation type not found'});
    }

    // Clean up CDN files for the curation type
    await cleanupCurationTypeCdnFiles(type);

    // Clear the icon field
    await type.update({icon: null}, { transaction });

    await transaction.commit();

    await updateDifficultiesHash();

    return res.json({ success: true, message: 'Icon removed successfully' });
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error deleting curation icon:', error);
    return res.status(500).json({error: 'Failed to delete icon'});
  }
  }
);

// Update curation type sort orders
router.put(
  '/types/sort-orders',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'putAdminCurationTypesSortOrders',
    summary: 'Update curation type sort orders',
    description: 'Body: sortOrders (array of { id, sortOrder }). Super admin password.',
    tags: ['Admin', 'Curations'],
    security: ['bearerAuth'],
    requestBody: { description: 'sortOrders', schema: { type: 'object', properties: { sortOrders: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' }, sortOrder: { type: 'number' } } } } }, required: ['sortOrders'] }, required: true },
    responses: { 200: { description: 'Sort orders updated' }, ...standardErrorResponses400500 },
  }),
  async (req, res) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const { sortOrders } = req.body;

    if (!sortOrders || !Array.isArray(sortOrders)) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({error: 'Sort orders array is required'});
    }

    const ids = [...new Set(sortOrders.map((s: { id: number }) => s.id))];
    const loaded = await CurationType.findAll({
      where: { id: { [Op.in]: ids } },
      transaction,
    });
    if (loaded.length !== ids.length) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({ error: 'One or more curation type IDs are invalid' });
    }

    const normalizeGroup = (g: string | null | undefined) => (g || '').trim();
    const groupKeys = new Set(loaded.map((t) => normalizeGroup(t.group)));
    if (groupKeys.size > 1) {
      await safeTransactionRollback(transaction);
      return res.status(400).json({
        error: 'All sort orders must apply to curation types in the same group',
      });
    }

    for (const { id, sortOrder } of sortOrders) {
      const type = loaded.find((t) => t.id === id);
      if (type) {
        await type.update({ sortOrder }, { transaction });
      }
    }

    await transaction.commit();

    await updateDifficultiesHash();
    const io = getIO();
    io.emit('curationTypesReordered');
    sseManager.broadcast({
      type: 'curationTypesReordered',
      data: { action: 'reorder', count: sortOrders.length },
    });

    logger.debug(`Successfully updated sort orders for ${sortOrders.length} curation types`);
    return res.json({success: true, message: 'Sort orders updated successfully'});
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error updating curation type sort orders:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
  }
);

// Update curation type group sort orders (same pattern as level tags)
router.put(
  '/types/group-sort-orders',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'putAdminCurationTypeGroupSortOrders',
    summary: 'Update curation type group sort orders',
    description: 'Body: groups[{ name, sortOrder }]. Super admin password.',
    tags: ['Admin', 'Curations'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'groups',
      schema: {
        type: 'object',
        properties: {
          groups: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, sortOrder: { type: 'number' } },
            },
          },
        },
        required: ['groups'],
      },
      required: true,
    },
    responses: { 200: { description: 'Group sort orders updated' }, ...standardErrorResponses400500 },
  }),
  async (req, res) => {
    let transaction: any;
    try {
      transaction = await sequelize.transaction();
      const { groups } = req.body;

      if (!Array.isArray(groups)) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'Invalid groups format' });
      }

      await Promise.all(
        groups.map(async (item: { name: string | null; sortOrder: number }) => {
          const { name, sortOrder } = item;
          if (name === undefined || sortOrder === undefined) {
            throw new Error('Missing name or sortOrder in groups array');
          }

          const whereClause =
            name === '' || name === null
              ? { [Op.or]: [{ group: null }, { group: '' }] }
              : { group: name };

          await CurationType.update({ groupSortOrder: sortOrder }, { where: whereClause, transaction });
        })
      );

      await transaction.commit();

      await updateDifficultiesHash();
      const io = getIO();
      io.emit('curationTypesReordered');
      sseManager.broadcast({
        type: 'curationTypesReordered',
        data: { action: 'groupReorder', count: groups.length },
      });

      return res.json({ message: 'Group sort orders updated successfully' });
    } catch (error) {
      await safeTransactionRollback(transaction);
      logger.error('Error updating curation type group sort orders:', error);
      return res.status(500).json({
        error: 'Failed to update group sort orders',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
);

const serializeCurationRow = (curation: InstanceType<typeof Curation>) => serializeCurationJson(curation);

const levelIncludeFull = [
  { model: CurationType, as: 'types' as const, through: { attributes: [] } },
  {
    model: Level,
    as: 'level' as const,
    include: [
      { model: Difficulty, as: 'difficulty' as const },
      {
        model: LevelCredit,
        as: 'levelCredits' as const,
        include: [{ model: Creator, as: 'creator' as const }],
      },
      { model: Team, as: 'teamObject' as const },
    ],
  },
];

const levelIncludeHashSearch = [
  { model: CurationType, as: 'types' as const, through: { attributes: [] } },
  {
    model: Level,
    as: 'level' as const,
    include: [
      { model: Difficulty, as: 'difficulty' as const },
      {
        model: LevelCredit,
        as: 'levelCredits' as const,
        include: [{ model: Creator, as: 'creator' as const }],
      },
    ],
  },
];

function parseCurationTypeIdsFromQuery(req: Request): number[] {
  const raw: number[] = [];
  const push = (v: unknown) => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) raw.push(n);
  };
  const { typeId, typeIds } = req.query;
  if (typeId) push(Array.isArray(typeId) ? typeId[0] : typeId);
  if (typeIds !== undefined && typeIds !== null) {
    const parts = Array.isArray(typeIds) ? typeIds : String(typeIds).split(',');
    for (const p of parts) push(String(p).trim());
  }
  return [...new Set(raw)];
}

function parseTypeIdQueryList(req: Request, param: string): number[] {
  const v = req.query[param];
  if (v === undefined || v === null) return [];
  const parts = Array.isArray(v) ? v : String(v).split(',');
  const raw: number[] = [];
  for (const p of parts) {
    const n = Number(String(p).trim());
    if (Number.isFinite(n) && n > 0) raw.push(n);
  }
  return [...new Set(raw)];
}

/**
 * Restrict curations to levels that have ALL mustHaveTypeIds (as curations) and NONE of excludeTypeIds.
 * Intersects with any existing where.levelId constraint from search / levelId query param.
 */
async function applyLevelTypeFiltersForCurations(
  where: Record<string, unknown>,
  mustHaveTypeIds: number[],
  excludeTypeIds: number[]
): Promise<'ok' | 'empty'> {
  if (mustHaveTypeIds.length === 0 && excludeTypeIds.length === 0) return 'ok';

  let allowed: Set<number> | null = null;
  const existing = where.levelId;

  if (typeof existing === 'number') {
    allowed = new Set([existing]);
  } else if (typeof existing === 'string' && /^\d+$/.test(existing)) {
    allowed = new Set([parseInt(existing, 10)]);
  } else if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    const arr = (existing as {[key: symbol]: unknown})[Op.in];
    if (Array.isArray(arr)) allowed = new Set(arr as number[]);
  }

  if (mustHaveTypeIds.length > 0) {
    const rows = await sequelize.query<{ levelId: number }>(
      `SELECT c.levelId FROM curations c
       INNER JOIN curation_curation_types cct ON cct.curationId = c.id
       WHERE cct.typeId IN (:typeIds)
       GROUP BY c.levelId
       HAVING COUNT(DISTINCT cct.typeId) = :n`,
      {
        replacements: { typeIds: mustHaveTypeIds, n: mustHaveTypeIds.length },
        type: QueryTypes.SELECT,
      }
    );
    const must = new Set(rows.map((r) => r.levelId));
    if (allowed === null) {
      allowed = must;
    } else {
      allowed = new Set([...allowed].filter((id) => must.has(id)));
    }
    if (allowed.size === 0) return 'empty';
  }

  if (excludeTypeIds.length > 0) {
    const withExcluded = await sequelize.query<{ levelId: number }>(
      `SELECT DISTINCT c.levelId FROM curations c
       INNER JOIN curation_curation_types cct ON cct.curationId = c.id
       WHERE cct.typeId IN (:excludeIds)`,
      { replacements: { excludeIds: excludeTypeIds }, type: QueryTypes.SELECT }
    );
    const bad = new Set(withExcluded.map((r) => r.levelId));
    if (allowed === null) {
      const allRows = await sequelize.query<{ levelId: number }>(
        `SELECT DISTINCT levelId FROM curations`,
        { type: QueryTypes.SELECT }
      );
      allowed = new Set(allRows.map((r) => r.levelId).filter((id) => !bad.has(id)));
    } else {
      allowed = new Set([...allowed].filter((id) => !bad.has(id)));
    }
    if (allowed.size === 0) return 'empty';
  }

  if (allowed === null || allowed.size === 0) return 'empty';
  where.levelId = { [Op.in]: [...allowed] };
  return 'ok';
}

// Get all curations with pagination and filters
router.get(
  '/',
  ApiDoc({
    operationId: 'getAdminCurations',
    summary: 'List curations',
    description:
      'Paginated curations. Query: typeId/typeIds (row filter OR), mustHaveTypeIds (level must have ALL), excludeTypeIds (level must have NONE), groupByLevel, search, excludeIds. Optional facetQuery (JSON v1, curationTypes only; tags not supported).',
    tags: ['Admin', 'Curations'],
    query: {
      page: { schema: { type: 'string' } },
      offset: { schema: { type: 'string' } },
      limit: { schema: { type: 'string' } },
      facetQuery: { description: 'Facet filter JSON v1 (curationTypes only)', schema: { type: 'string' } },
      typeId: { schema: { type: 'string' } },
      typeIds: { schema: { type: 'string' } },
      mustHaveTypeIds: { schema: { type: 'string' } },
      excludeTypeIds: { schema: { type: 'string' } },
      levelId: { schema: { type: 'string' } },
      search: { schema: { type: 'string' } },
      excludeIds: { schema: { type: 'array', items: { type: 'string' } } },
      groupByLevel: { schema: { type: 'string' } },
    },
    responses: { 200: { description: 'Curations list' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const { page, limit, offset } = req.query as unknown as PaginationQuery;
    const { levelId, search, excludeIds } = req.query;

    const groupByLevel =
      req.query.groupByLevel === 'true' || req.query.groupByLevel === '1';

    const facetQueryRaw = req.query.facetQuery;
    const facetQueryParsed = parseFacetQueryString(
      typeof facetQueryRaw === 'string' ? facetQueryRaw : undefined
    );
    if (facetQueryParsed?.tags) {
      return res.status(400).json({
        error: 'facetQuery.tags is not supported for the curations list endpoint',
      });
    }

    const useFacetCurationTypes = Boolean(facetQueryParsed?.curationTypes);

    const where: Record<string, unknown> = {};

    if (useFacetCurationTypes && facetQueryParsed?.curationTypes) {
      const allowed = await levelIdsForCurationFacetDomain(facetQueryParsed.curationTypes);
      if (allowed !== null) {
        if (allowed.size === 0) {
          return res.json({
            curations: [],
            levelInstances: [],
            total: 0,
            page,
            offset,
            limit,
            totalPages: 0,
          });
        }
        if (mergeFacetLevelIds(where, allowed) === 'empty') {
          return res.json({
            curations: [],
            levelInstances: [],
            total: 0,
            page,
            offset,
            limit,
            totalPages: 0,
          });
        }
      }
    }

    const typeIdsParsed = useFacetCurationTypes ? [] : parseCurationTypeIdsFromQuery(req);

    const typesInclude: Record<string, unknown> = {
      model: CurationType,
      as: 'types',
      through: { attributes: [] },
    };
    if (typeIdsParsed.length > 0) {
      typesInclude.where =
        typeIdsParsed.length === 1
          ? { id: typeIdsParsed[0] }
          : { id: { [Op.in]: typeIdsParsed } };
      typesInclude.required = true;
    }

    const listIncludeBase = [typesInclude, levelIncludeFull[1]];

    if (levelId) where.levelId = levelId;

    if (excludeIds) {
      const excludeArray = Array.isArray(excludeIds) ? excludeIds : [excludeIds];
      where.id = { [Op.notIn]: excludeArray };
    }

    type SearchMode = 'none' | 'hash' | 'text';
    let searchMode: SearchMode = 'none';
    let matchingLevelIds: number[] = [];

    if (search) {
      const searchStr = Array.isArray(search) ? String(search[0]) : String(search);

      if (searchStr && searchStr.startsWith('#') && searchStr.length > 1) {
        const idStr = searchStr.substring(1);
        if (!/^\d+$/.test(idStr)) {
          return res.status(400).json({ error: 'Invalid level ID format after hashtag' });
        }
        searchMode = 'hash';
        where.levelId = parseInt(idStr, 10);
        logger.debug(`Direct level ID lookup for level ${idStr}`);
      } else {
        searchMode = 'text';
        const searchWhere = {
          [Op.or]: [
            { song: { [Op.like]: `%${searchStr}%` } },
            { artist: { [Op.like]: `%${searchStr}%` } },
            { creator: { [Op.like]: `%${searchStr}%` } },
          ],
        };
        const matchingLevels = await Level.findAll({
          where: searchWhere,
          attributes: ['id'],
        });
        matchingLevelIds = matchingLevels.map((level) => level.id);
        where.levelId = { [Op.in]: matchingLevelIds };
      }
    }

    if (searchMode === 'text' && matchingLevelIds.length === 0) {
      return res.json({
        curations: [],
        levelInstances: [],
        total: 0,
        page,
        offset,
        limit,
        totalPages: 0,
      });
    }

    const mustHaveTypeIds = useFacetCurationTypes
      ? []
      : parseTypeIdQueryList(req, 'mustHaveTypeIds');
    const excludeTypeIds = useFacetCurationTypes
      ? []
      : parseTypeIdQueryList(req, 'excludeTypeIds');
    const levelTypeFilterResult = await applyLevelTypeFiltersForCurations(
      where,
      mustHaveTypeIds,
      excludeTypeIds
    );
    if (levelTypeFilterResult === 'empty') {
      return res.json({
        curations: [],
        levelInstances: [],
        total: 0,
        page,
        offset,
        limit,
        totalPages: 0,
      });
    }

    if (groupByLevel) {
      const typeFilterInclude = typeIdsParsed.length ? [typesInclude] : undefined;
      const totalLevelCount = await Curation.count({
        where: where as any,
        distinct: true,
        col: 'levelId',
        ...(typeFilterInclude ? { include: typeFilterInclude } : {}),
      });

      const levelGroupRows = await Curation.findAll({
        attributes: [
          'levelId',
          [sequelize.fn('MAX', sequelize.col('createdAt')), 'maxCreated'],
        ],
        where: where as any,
        group: ['levelId'],
        order: [[sequelize.fn('MAX', sequelize.col('createdAt')), 'DESC']],
        limit: Number(limit),
        offset,
        raw: !typeFilterInclude,
        ...(typeFilterInclude ? { include: typeFilterInclude, subQuery: false } : {}),
      });

      const pageLevelIds = typeFilterInclude
        ? (levelGroupRows as InstanceType<typeof Curation>[]).map((r) => r.levelId)
        : (levelGroupRows as { levelId: number }[]).map((r) => r.levelId);

      if (pageLevelIds.length === 0) {
        const lim = Number(limit);
        return res.json({
          curations: [],
          levelInstances: [],
          total: totalLevelCount,
          page,
          offset,
          limit,
          totalPages: Math.ceil(totalLevelCount / lim) || 0,
        });
      }

      const { levelId: _omitLevel, ...whereSansLevel } = where;
      const fetchWhere = { ...whereSansLevel, levelId: { [Op.in]: pageLevelIds } };

      const rows = await Curation.findAll({
        where: fetchWhere as any,
        include: listIncludeBase as any,
        order: [['createdAt', 'DESC']],
      });

      const byLevel = new Map<number, InstanceType<typeof Curation>[]>();
      for (const id of pageLevelIds) byLevel.set(id, []);
      for (const c of rows) {
        const list = byLevel.get(c.levelId);
        if (list) list.push(c);
      }

      const levelInstances = pageLevelIds.map((lid) => {
        const list = sortCurationsByTypeOrder(byLevel.get(lid) ?? []);
        const first = list[0];
        const levelJson = first?.level ? (first.level.toJSON() as unknown as Record<string, unknown>) : null;
        return {
          level: levelJson,
          curations: list.map(serializeCurationRow),
        };
      });

      const lim = Number(limit);
      return res.json({
        curations: [],
        levelInstances,
        total: totalLevelCount,
        page,
        offset,
        limit,
        totalPages: Math.ceil(totalLevelCount / lim) || 0,
      });
    }

    let curations;
    const hashInclude = [typesInclude, levelIncludeHashSearch[1]];
    if (searchMode === 'hash') {
      curations = await Curation.findAndCountAll({
        where: where as any,
        include: hashInclude as any,
        limit: Number(limit),
        offset,
        order: [['createdAt', 'DESC']],
        distinct: true,
      });
    } else {
      curations = await Curation.findAndCountAll({
        where: where as any,
        include: listIncludeBase as any,
        limit: Number(limit),
        offset,
        order: [['createdAt', 'DESC']],
        distinct: true,
      });
    }

    const serializedCurations = curations.rows.map(serializeCurationRow);

    return res.json({
      curations: serializedCurations,
      total: curations.count,
      page,
      offset,
      limit,
      totalPages: Math.ceil(curations.count / Number(limit)),
    });
  } catch (error) {
    logger.error('Error fetching curations:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
  }
);

// Create curation
router.post(
  '/',
  requireCuratorOrRater,
  ApiDoc({
    operationId: 'postAdminCuration',
    summary: 'Create curation',
    description: 'Create curation for a level. Body: levelId. Curator or rater.',
    tags: ['Admin', 'Curations'],
    security: ['bearerAuth'],
    requestBody: { description: 'levelId', schema: { type: 'object', properties: { levelId: { type: 'number' } }, required: ['levelId'] }, required: true },
    responses: { 201: { description: 'Curation created' }, 400: { schema: errorResponseSchema }, 403: { schema: errorResponseSchema }, ...standardErrorResponses404500, 409: { schema: errorResponseSchema } },
  }),
  async (req: Request, res: Response) => {
  try {
    const {levelId} = req.body;
    const assignedBy = req.user?.id || 'unknown';

    if (!levelId) {
      return res.status(400).json({error: 'Level ID is required'});
    }

    // Check if level exists
    const level = await Level.findByPk(levelId);
    if (!level) {
      return res.status(404).json({error: 'Level not found'});
    }

    const existingCuration = await Curation.findOne({
      where: { levelId },
      include: [{ model: CurationType, as: 'types', through: { attributes: [] } }],
    });

    if (existingCuration) {
      return res.status(409).json({ error: 'This level already has a curation' });
    }

    // Get level with creators BEFORE creating curation to capture old state
    const levelWithCreators = await Level.findByPk(levelId, {
      include: [
        {
          model: LevelCredit,
          as: 'levelCredits',
          include: [{
            model: Creator,
            as: 'creator',
          }],
        },
      ],
    });

    // Get old curation type sets for affected creators
    const creatorIds = levelWithCreators?.levelCredits
      ?.map(credit => credit.creator?.id)
      .filter((id): id is number => id !== null && id !== undefined) ?? [];

    const oldCurationTypeSets = creatorIds.length > 0
      ? await roleSyncService.getCreatorsCurationTypeSets(creatorIds)
      : undefined;

    const curation = await Curation.create({
      levelId,
      assignedBy,
    });

    // Fetch the complete curation with related data
    const completeCuration = await Curation.findByPk(curation.id, {
      include: [
        {
          model: CurationType,
          as: 'types',
          through: { attributes: [] },
        },
        {
          model: Level,
          as: 'level',
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
            },
            {
              model: LevelCredit,
              as: 'levelCredits',
              include: [{
                model: Creator,
                as: 'creator',
              }],
            },
            {
              model: Team,
              as: 'teamObject',
            },
          ],
        },
      ],
    });

    const serializedCuration = completeCuration ? serializeCurationRow(completeCuration) : null;

    elasticsearchService.indexLevel(levelId);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    syncRolesForLevel(completeCuration?.levelId, oldCurationTypeSets);

    return res.status(201).json({ curation: serializedCuration });
  } catch (error) {
    logger.error('Error creating curation:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
  }
);

type PutLevelCurationBody = {
  shortDescription?: string | null;
  description?: string | null;
  customCSS?: string | null;
  customColor?: string | null;
  /** Replace the set of curation types (required for PUT /level/:levelId) */
  typeIds?: number[];
};

/** Thrown from PUT /level/:levelId handler; handled in catch, rollback in finally */
type PutLevelCurationHttpError = { status: number; error: string };

function isPutLevelCurationHttpError(e: unknown): e is PutLevelCurationHttpError {
  return (
    typeof e === 'object' &&
    e !== null &&
    'status' in e &&
    'error' in e &&
    typeof (e as PutLevelCurationHttpError).status === 'number' &&
    typeof (e as PutLevelCurationHttpError).error === 'string'
  );
}

function userCanAssignCurationTypeAbilities(req: Request, typeAbilities: bigint): boolean {
  if (!req.user) return false;
  if (hasAnyFlag(req.user, [permissionFlags.SUPER_ADMIN, permissionFlags.HEAD_CURATOR])) {
    return true;
  }
  if (hasAnyFlag(req.user, [permissionFlags.CURATOR, permissionFlags.RATER])) {
    return canAssignCurationType(BigInt(req.user.permissionFlags || 0), typeAbilities);
  }
  return false;
}

/** OR semantics for visual fields from the selected curation types (short + long description share description abilities). */
function curationTypeVisualAbilityFlags(types: CurationType[]) {
  const anyAllowsCss = types.some((t) => hasAbility(t, curationTypeAbilities.CUSTOM_CSS));
  const anyAllowsColor = types.some((t) => hasAbility(t, curationTypeAbilities.CUSTOM_COLOR_THEME));
  const anyAllowsDescription = types.some((t) =>
    hasAbility(t, curationTypeAbilities.ALLOW_DESCRIPTION) ||
    hasAbility(t, curationTypeAbilities.FORCE_DESCRIPTION)
  );
  return { anyAllowsCss, anyAllowsColor, anyAllowsDescription };
}

const curationIncludeForLevelResponse = [
  { model: CurationType, as: 'types' as const, through: { attributes: [] } },
  {
    model: Level,
    as: 'level' as const,
    include: [
      { model: Difficulty, as: 'difficulty' as const },
      {
        model: LevelCredit,
        as: 'levelCredits' as const,
        include: [{ model: Creator, as: 'creator' as const }],
      },
      { model: Team, as: 'teamObject' as const },
    ],
  },
];

// Replace all curations for a level (create / update / delete) in one request
router.put(
  '/level/:levelId([0-9]{1,20})',
  requireCuratorOrRater,
  ApiDoc({
    operationId: 'putAdminCurationsForLevel',
    summary: 'Bulk sync curations for a level',
    description:
      'Body: { shortDescription?, description?, customCSS?, customColor?, typeIds: number[] }. One curation per level; typeIds replaces linked types.',
    tags: ['Admin', 'Curations'],
    security: ['bearerAuth'],
    params: { levelId: stringIdParamSpec },
    requestBody: {
      description: 'curation fields and typeIds',
      schema: {
        type: 'object',
        properties: {
          typeIds: { type: 'array', items: { type: 'number' } },
          shortDescription: { type: 'string' },
          description: { type: 'string' },
          customCSS: { type: 'string' },
          customColor: { type: 'string' },
        },
        required: ['typeIds'],
      },
      required: true,
    },
    responses: { 200: { description: 'Updated curations for level' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
    let transaction: any;
    let committed = false;
    let errorResponse: { status: number; body: { error: string } } | null = null;
    let successPayload: { levelId: number; curations: ReturnType<typeof serializeCurationRow>[] } | null = null;

    try {
      transaction = await sequelize.transaction();
      const levelId = parseInt(req.params.levelId, 10);
      const body = req.body as PutLevelCurationBody;
      const { shortDescription, description, customCSS, customColor } = body;
      const typeIdsRaw = body.typeIds;

      if (!Array.isArray(typeIdsRaw)) {
        throw { status: 400, error: 'typeIds must be an array' };
      }

      const uniqueTypeIds = [...new Set(typeIdsRaw.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];

      const level = await Level.findByPk(levelId, { transaction });
      if (!level) {
        throw { status: 404, error: 'Level not found' };
      }

      const assignedBy = req.user?.id || 'unknown';

      const levelWithCreators = await Level.findByPk(levelId, {
        transaction,
        include: [
          {
            model: LevelCredit,
            as: 'levelCredits',
            include: [{ model: Creator, as: 'creator' }],
          },
        ],
      });

      const creatorIds =
        levelWithCreators?.levelCredits
          ?.map((credit) => credit.creator?.id)
          .filter((id): id is number => id !== null && id !== undefined) ?? [];

      const oldCurationTypeSets =
        creatorIds.length > 0
          ? await roleSyncService.getCreatorsCurationTypeSets(creatorIds)
          : undefined;

      let existingRow = await Curation.findOne({
        where: { levelId },
        include: [{ model: CurationType, as: 'types', through: { attributes: [] } }],
        transaction,
      });

      const oldTypeIds = new Set((existingRow?.types || []).map((t) => t.id));
      const newTypeIds = new Set(uniqueTypeIds);

      // Layered permission: if this curation already has any restricted type(s),
      // require the user to be able to assign ALL of them ("most restricted wins").
      if (
        existingRow &&
        (existingRow.types || []).length > 0 &&
        !hasAnyFlag(req.user, [permissionFlags.SUPER_ADMIN, permissionFlags.HEAD_CURATOR])
      ) {
        const userFlags = BigInt(req.user?.permissionFlags || 0);
        for (const t of existingRow.types || []) {
          if (!canAssignCurationType(userFlags, BigInt(t.abilities))) {
            throw { status: 403, error: 'You do not have permission to manage this curation' };
          }
        }
      }

      const typeRows =
        uniqueTypeIds.length > 0
          ? await CurationType.findAll({
              where: { id: { [Op.in]: uniqueTypeIds } },
              transaction,
            })
          : [];
      const typeById = new Map(typeRows.map((t) => [t.id, t]));
      if (typeRows.length !== uniqueTypeIds.length) {
        throw { status: 400, error: 'One or more curation types not found' };
      }

      for (const tid of uniqueTypeIds) {
        const t = typeById.get(tid)!;
        if (!userCanAssignCurationTypeAbilities(req, BigInt(t.abilities))) {
          throw { status: 403, error: 'You cannot assign one or more curation types' };
        }
      }

      for (const tid of oldTypeIds) {
        if (!newTypeIds.has(tid)) {
          const t = await CurationType.findByPk(tid, { transaction });
          if (t && !userCanAssignCurationTypeAbilities(req, BigInt(t.abilities))) {
            throw { status: 403, error: 'You do not have permission to remove one or more curation types' };
          }
        }
      }

      // Visual field gating (OR): only when the client sends the field (partial updates omit keys they are not editing).
      // Sending customCSS: "" still counts as an attempted edit.
      const bodyHas = (key: keyof PutLevelCurationBody) =>
        Object.prototype.hasOwnProperty.call(body, key);
      const wantsShortDescription = bodyHas('shortDescription');
      const wantsCss = bodyHas('customCSS');
      const wantsColor = bodyHas('customColor');
      const wantsDescription = bodyHas('description');
      const wantsAnyDescriptionField = wantsShortDescription || wantsDescription;

      // Visual field gating (OR): if any selected type enables CSS/color/description, that field may be updated.
      // shortDescription and description share the same ability flags (treat short as part of the description content).
      // Who may actually edit is still constrained by tier checks above (must assign every existing type, etc.).
      if (!hasAnyFlag(req.user, [permissionFlags.SUPER_ADMIN, permissionFlags.HEAD_CURATOR])) {
        if (uniqueTypeIds.length === 0) {
          if (wantsCss) {
            throw { status: 403, error: 'You do not have permission to edit custom CSS for this curation' };
          }
          if (wantsColor) {
            throw { status: 403, error: 'You do not have permission to edit custom color for this curation' };
          }
          if (wantsAnyDescriptionField) {
            throw { status: 403, error: 'You do not have permission to edit description for this curation' };
          }
        } else {
          const { anyAllowsCss, anyAllowsColor, anyAllowsDescription } = curationTypeVisualAbilityFlags(typeRows);

          if (wantsCss && !anyAllowsCss) {
            throw { status: 403, error: 'You do not have permission to edit custom CSS for this curation' };
          }
          if (wantsColor && !anyAllowsColor) {
            throw { status: 403, error: 'You do not have permission to edit custom color for this curation' };
          }
          if (wantsAnyDescriptionField && !anyAllowsDescription) {
            throw { status: 403, error: 'You do not have permission to edit description for this curation' };
          }
        }
      }

      const shortVal = wantsShortDescription ? shortDescription : existingRow?.shortDescription;
      const descVal = wantsDescription ? description : existingRow?.description;
      for (const tid of uniqueTypeIds) {
        const t = typeById.get(tid)!;
        if (
          hasAbility(t, curationTypeAbilities.FORCE_DESCRIPTION) &&
          !String(shortVal ?? '').trim() &&
          !String(descVal ?? '').trim()
        ) {
          throw {
            status: 400,
            error: `Description is required for curation type "${t.name}"`,
          };
        }
      }

      const hasContentFields =
        wantsShortDescription ||
        wantsDescription ||
        wantsCss ||
        wantsColor;

      if (!existingRow && uniqueTypeIds.length === 0 && !hasContentFields) {
        throw {
          status: 400,
          error: 'Provide typeIds and/or content fields to create or update the level curation',
        };
      }

      // Upsert then reload: MySQL upsert often does not populate `id` on the returned instance,
      // and BelongsToMany.setTypes requires a defined primary key for the junction WHERE.
      await Curation.upsert(
        {
          levelId,
          assignedBy,
          shortDescription: wantsShortDescription ? (shortDescription ?? '') : (existingRow?.shortDescription ?? ''),
          description: wantsDescription ? (description ?? null) : (existingRow?.description ?? null),
          customCSS: wantsCss ? (customCSS ?? null) : (existingRow?.customCSS ?? null),
          customColor: wantsColor ? (customColor ?? null) : (existingRow?.customColor ?? null),
        },
        { transaction },
      );
      const row = await Curation.findOne({
        where: { levelId },
        transaction,
      });
      if (!row) {
        throw { status: 500, error: 'Failed to load curation after save' };
      }
      await row.setTypes(uniqueTypeIds, { transaction });

      await transaction.commit();
      committed = true;

      const finalRows = await Curation.findAll({
        where: { levelId },
        include: curationIncludeForLevelResponse,
        order: [['createdAt', 'ASC']],
      });

      const sorted = sortCurationsByTypeOrder(finalRows);
      const curationsOut = sorted.map(serializeCurationRow);

      await elasticsearchService.indexLevel(levelId);
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      syncRolesForLevel(levelId, oldCurationTypeSets);
      CacheInvalidation.invalidateTag(`level:${levelId}`);

      successPayload = { levelId, curations: curationsOut };
    } catch (error: unknown) {
      if (isPutLevelCurationHttpError(error)) {
        errorResponse = { status: error.status, body: { error: error.error } };
      } else {
        logger.error('Error bulk-updating curations for level:', error);
        errorResponse = { status: 500, body: { error: 'Internal server error' } };
      }
    } finally {
      if (!committed) {
        await safeTransactionRollback(transaction);
      }
    }

    if (errorResponse) {
      return res.status(errorResponse.status).json(errorResponse.body);
    }
    if (successPayload) {
      return res.json(successPayload);
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
);

// Update curation
router.put(
  '/:id([0-9]{1,20})',
  requireCurationManagementPermission,
  ApiDoc({
    operationId: 'putAdminCuration',
    summary: 'Update curation',
    description: 'Update curation. Body: shortDescription?, description?, customCSS?, customColor?, typeIds?. Requires curation permission.',
    tags: ['Admin', 'Curations'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    requestBody: { description: 'shortDescription, description, customCSS, customColor, typeIds', schema: { type: 'object' }, required: true },
    responses: { 200: { description: 'Curation updated' }, ...standardErrorResponses403404500 },
  }),
  async (req: Request, res: Response) => {
  let transaction: any;
  try {
    transaction = await sequelize.transaction();
    const {id} = req.params;
    const body = req.body as PutLevelCurationBody;
    const { shortDescription, description, customCSS, customColor, typeIds } = body;
    const bodyHasPut = (key: keyof PutLevelCurationBody) =>
      Object.prototype.hasOwnProperty.call(body, key);
    const wantsShort = bodyHasPut('shortDescription');
    const wantsDesc = bodyHasPut('description');
    const wantsCssPut = bodyHasPut('customCSS');
    const wantsColorPut = bodyHasPut('customColor');
    const wantsAnyDescriptionFieldPut = wantsShort || wantsDesc;

    const curation = await Curation.findByPk(id, {
      transaction,
      include: [{ model: CurationType, as: 'types', through: { attributes: [] } }],
    });
    if (!curation) {
      return res.status(404).json({error: 'Curation not found'});
    }

    let typesForVisualPut: InstanceType<typeof CurationType>[] = [];
    if (Array.isArray(typeIds)) {
      const uniqueTypeIdsPut = [...new Set(typeIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
      if (uniqueTypeIdsPut.length > 0) {
        typesForVisualPut = await CurationType.findAll({
          where: { id: { [Op.in]: uniqueTypeIdsPut } },
          transaction,
        });
      }
    } else {
      typesForVisualPut = curation.types || [];
    }

    if (!hasAnyFlag(req.user, [permissionFlags.SUPER_ADMIN, permissionFlags.HEAD_CURATOR])) {
      if (typesForVisualPut.length === 0) {
        if (wantsCssPut || wantsColorPut || wantsAnyDescriptionFieldPut) {
          await safeTransactionRollback(transaction);
          return res.status(403).json({ error: 'You do not have permission to edit these curation fields' });
        }
      } else {
        const { anyAllowsCss, anyAllowsColor, anyAllowsDescription } = curationTypeVisualAbilityFlags(typesForVisualPut);
        if (wantsCssPut && !anyAllowsCss) {
          await safeTransactionRollback(transaction);
          return res.status(403).json({ error: 'You do not have permission to edit custom CSS for this curation' });
        }
        if (wantsColorPut && !anyAllowsColor) {
          await safeTransactionRollback(transaction);
          return res.status(403).json({ error: 'You do not have permission to edit custom color for this curation' });
        }
        if (wantsAnyDescriptionFieldPut && !anyAllowsDescription) {
          await safeTransactionRollback(transaction);
          return res.status(403).json({ error: 'You do not have permission to edit description for this curation' });
        }
      }
    }

    // Get level with creators BEFORE update to capture old state
    const levelWithCreators = await Level.findByPk(curation.levelId, {
      transaction,
      include: [
        {
          model: LevelCredit,
          as: 'levelCredits',
          include: [{
            model: Creator,
            as: 'creator',
          }],
        },
      ],
    });

    // Get old curation type sets for affected creators
    const creatorIds = levelWithCreators?.levelCredits
      ?.map(credit => credit.creator?.id)
      .filter((id): id is number => id !== null && id !== undefined) ?? [];

    const oldCurationTypeSets = creatorIds.length > 0
      ? await roleSyncService.getCreatorsCurationTypeSets(creatorIds)
      : undefined;

    await curation.update(
      {
        ...(wantsShort ? { shortDescription } : {}),
        ...(wantsDesc ? { description } : {}),
        ...(wantsCssPut ? { customCSS } : {}),
        ...(wantsColorPut ? { customColor } : {}),
      },
      { transaction }
    );

    if (Array.isArray(typeIds)) {
      const uniqueTypeIds = [...new Set(typeIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
      const typeRows =
        uniqueTypeIds.length > 0
          ? await CurationType.findAll({
              where: { id: { [Op.in]: uniqueTypeIds } },
              transaction,
            })
          : [];
      const typeById = new Map(typeRows.map((t) => [t.id, t]));
      if (typeRows.length !== uniqueTypeIds.length) {
        await safeTransactionRollback(transaction);
        return res.status(400).json({ error: 'One or more curation types not found' });
      }
      const oldTypeIds = new Set((curation.types || []).map((t) => t.id));
      const newTypeIds = new Set(uniqueTypeIds);
      for (const tid of uniqueTypeIds) {
        const t = typeById.get(tid)!;
        if (!userCanAssignCurationTypeAbilities(req, BigInt(t.abilities))) {
          await safeTransactionRollback(transaction);
          return res.status(403).json({ error: 'You cannot assign one or more curation types' });
        }
      }
      for (const tid of oldTypeIds) {
        if (!newTypeIds.has(tid)) {
          const t = await CurationType.findByPk(tid, { transaction });
          if (t && !userCanAssignCurationTypeAbilities(req, BigInt(t.abilities))) {
            await safeTransactionRollback(transaction);
            return res.status(403).json({ error: 'You do not have permission to remove one or more curation types' });
          }
        }
      }
      const shortValPut = wantsShort ? shortDescription : curation.shortDescription;
      const descValPut = wantsDesc ? description : curation.description;
      for (const tid of uniqueTypeIds) {
        const t = typeById.get(tid)!;
        if (
          hasAbility(t, curationTypeAbilities.FORCE_DESCRIPTION) &&
          !String(shortValPut ?? '').trim() &&
          !String(descValPut ?? '').trim()
        ) {
          await safeTransactionRollback(transaction);
          return res.status(400).json({
            error: `Description is required for curation type "${t.name}"`,
          });
        }
      }
      await curation.setTypes(uniqueTypeIds, { transaction });
    }

    const completeCuration = await Curation.findByPk(id, {
      transaction,
      include: [
        {
          model: CurationType,
          as: 'types',
          through: { attributes: [] },
        },
        {
          model: Level,
          as: 'level',
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
            },
            {
              model: LevelCredit,
              as: 'levelCredits',
              include: [{
                model: Creator,
                as: 'creator',
              }],
            },
            {
              model: Team,
              as: 'teamObject',
            },
          ],
        },
      ],
    });

    await transaction.commit();
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    syncRolesForLevel(completeCuration?.levelId, oldCurationTypeSets);
    const serializedCuration = completeCuration ? serializeCurationRow(completeCuration) : null;

    return res.json({ curation: serializedCuration });
  } catch (error) {
    logger.error('Error updating curation:', error);
    await safeTransactionRollback(transaction);
    return res.status(500).json({error: 'Internal server error'});
  }
  }
);

// Get single curation
router.get(
  '/:id([0-9]{1,20})',
  ApiDoc({
    operationId: 'getAdminCuration',
    summary: 'Get curation',
    description: 'Get single curation by id.',
    tags: ['Admin', 'Curations'],
    params: { id: stringIdParamSpec },
    responses: { 200: { description: 'Curation' }, ...standardErrorResponses404500 },
  }),
  async (req, res) => {
  try {
    const {id} = req.params;

    const curation = await Curation.findByPk(id, {
      include: [
        {
          model: CurationType,
          as: 'types',
          through: { attributes: [] },
        },
        {
          model: Level,
          as: 'level',
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
            },
            {
              model: LevelCredit,
              as: 'levelCredits',
              include: [{
                model: Creator,
                as: 'creator',
              }],
            },
            {
              model: Team,
              as: 'teamObject',
            },
          ],
        },
      ],
    });

    if (!curation) {
      return res.status(404).json({error: 'Curation not found'});
    }

    return res.json(serializeCurationRow(curation));
  } catch (error) {
    logger.error('Error fetching curation:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
  }
);

// Delete curation
router.delete(
  '/:id([0-9]{1,20})',
  requireCurationManagementPermission,
  ApiDoc({
    operationId: 'deleteAdminCuration',
    summary: 'Delete curation',
    description: 'Delete curation. Requires curation management permission.',
    tags: ['Admin', 'Curations'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 200: { description: 'Curation deleted' }, ...standardErrorResponses403404500 },
  }),
  async (req: Request, res: Response) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const {id} = req.params;

    const curation = await Curation.findByPk(id, { transaction });
    if (!curation) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Curation not found'});
    }

    // Get level with creators BEFORE deletion to capture old state
    const levelWithCreators = await Level.findByPk(curation.levelId, {
      transaction,
      include: [
        {
          model: LevelCredit,
          as: 'levelCredits',
          include: [{
            model: Creator,
            as: 'creator',
          }],
        },
      ],
    });

    // Get old curation type sets for affected creators
    const creatorIds = levelWithCreators?.levelCredits
      ?.map(credit => credit.creator?.id)
      .filter((id): id is number => id !== null && id !== undefined) ?? [];

    const oldCurationTypeSets = creatorIds.length > 0
      ? await roleSyncService.getCreatorsCurationTypeSets(creatorIds)
      : undefined;

    // Clean up CDN files for this curation
    await cleanupCurationCdnFiles([curation]);
    // Delete the curation (this will cascade delete related schedules)
    await curation.destroy({ transaction });

    await transaction.commit();

    // Reindex the level
    await elasticsearchService.indexLevel(curation.levelId);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    syncRolesForLevel(curation.levelId, oldCurationTypeSets);


    logger.debug(`Successfully deleted curation ${id} and cleaned up related resources`);
    return res.status(200).json({
      success: true,
      message: 'Curation deleted successfully',
    });
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error deleting curation:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
  }
);

// Get curation schedules
// All dates are handled in UTC to avoid timezone issues
router.get(
  '/schedules',
  ApiDoc({
    operationId: 'getAdminCurationSchedules',
    summary: 'List curation schedules',
    description: 'Get schedules for a week. Query: weekStart (optional).',
    tags: ['Admin', 'Curations'],
    query: { weekStart: { schema: { type: 'string' } } },
    responses: { 200: { description: 'Schedules' }, ...standardErrorResponses500 },
  }),
  async (req, res) => {
  try {
    const { weekStart } = req.query;

    const where: any = { isActive: true };

    // Always use UTC dates for consistency
    let targetWeekStart: Date;

    if (weekStart) {
      // If weekStart is provided, use it but ensure it's treated as UTC
      const inputDate = new Date(weekStart as string);
      const dayOfWeek = inputDate.getUTCDay(); // Use UTC day of week
      const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Convert to Monday-based week

      targetWeekStart = new Date(inputDate);
      targetWeekStart.setUTCDate(inputDate.getUTCDate() - daysToSubtract);
      // Set to start of day in UTC
      targetWeekStart.setUTCHours(0, 0, 0, 0);
    } else {
      // If no weekStart provided, automatically calculate current week in UTC
      const now = new Date();
      const dayOfWeek = now.getUTCDay(); // Use UTC day of week
      const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Convert to Monday-based week

      targetWeekStart = new Date(now);
      targetWeekStart.setUTCDate(now.getUTCDate() - daysToSubtract);
      // Set to start of day in UTC
      targetWeekStart.setUTCHours(0, 0, 0, 0);
    }
    where.weekStart = targetWeekStart;

    const schedules = await CurationSchedule.findAll({
      where,
      include: [
        {
          model: Curation,
          as: 'scheduledCuration',
          include: [
            {
              model: CurationType,
              as: 'types',
              through: { attributes: [] },
            },
            {
              model: Level,
              as: 'level',
              include: [
                {
                  model: Difficulty,
                  as: 'difficulty',
                },
                {
                  model: LevelCredit,
                  as: 'levelCredits',
                  include: [{
                    model: Creator,
                    as: 'creator',
                  }],
                }
              ],
            },
          ],
        },
      ],
      order: [['listType', 'ASC'], ['position', 'ASC']],
    });

    const levelIds = [
      ...new Set(
        schedules
          .map((s) => s.scheduledCuration?.levelId)
          .filter((id): id is number => typeof id === 'number')
      ),
    ];

    const allCurationsRows =
      levelIds.length > 0
        ? await Curation.findAll({
            where: { levelId: { [Op.in]: levelIds } },
            include: [{ model: CurationType, as: 'types', through: { attributes: [] } }],
          })
        : [];

    const curationsByLevelId = new Map<number, typeof allCurationsRows>();
    for (const c of allCurationsRows) {
      if (!curationsByLevelId.has(c.levelId)) {
        curationsByLevelId.set(c.levelId, []);
      }
      curationsByLevelId.get(c.levelId)!.push(c);
    }

    const serializedSchedules = schedules.map((schedule) => {
      const lid = schedule.scheduledCuration?.levelId;
      const allForLevel = lid
        ? sortCurationsByTypeOrder(curationsByLevelId.get(lid) || []).map(serializeCurationRow)
        : [];
      const sc = schedule.scheduledCuration;
      return {
        ...schedule.toJSON(),
        scheduledCuration: sc
          ? {
              ...serializeCurationRow(sc),
              allCurationsForLevel: allForLevel,
            }
          : null,
      };
    });

    return res.json({
      schedules: serializedSchedules,
    });
  } catch (error) {
    logger.error('Error fetching curation schedules:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
  }
);

// Create curation schedule
// All dates are handled in UTC to avoid timezone issues
router.post(
  '/schedules',
  Auth.headCurator(),
  ApiDoc({
    operationId: 'postAdminCurationSchedule',
    summary: 'Create curation schedule',
    description: 'Schedule a curation for a week. Body: curationId, weekStart, listType (primary|secondary). Head curator.',
    tags: ['Admin', 'Curations'],
    security: ['bearerAuth'],
    requestBody: { description: 'curationId, weekStart, listType', schema: { type: 'object', properties: { curationId: { type: 'number' }, weekStart: { type: 'string' }, listType: { type: 'string' } }, required: ['curationId', 'weekStart', 'listType'] }, required: true },
    responses: { 201: { description: 'Schedule created' }, 400: { schema: errorResponseSchema }, ...standardErrorResponses404500, 409: { schema: errorResponseSchema } },
  }),
  async (req, res) => {
  try {
    const { curationId, weekStart, listType } = req.body;
    const scheduledBy = req.user?.id || 'unknown';

    if (!curationId || !weekStart || !listType) {
      return res.status(400).json({error: 'Curation ID, Week Start, and List Type are required'});
    }

    // Check if curation exists
    const curation = await Curation.findByPk(curationId);
    if (!curation) {
      return res.status(404).json({error: 'Curation not found'});
    }

    // Validate listType
    if (!['primary', 'secondary'].includes(listType)) {
      return res.status(400).json({error: 'List type must be either "primary" or "secondary"'});
    }

    // Ensure weekStart is treated as UTC and normalized to start of week
    const inputDate = new Date(weekStart);
    const dayOfWeek = inputDate.getUTCDay(); // Use UTC day of week
    const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Convert to Monday-based week

    const weekStartDate = new Date(inputDate);
    weekStartDate.setUTCDate(inputDate.getUTCDate() - daysToSubtract);
    // Set to start of day in UTC
    weekStartDate.setUTCHours(0, 0, 0, 0);

    // Check for existing schedule for this curation in the same week and list type
    const existingSchedule = await CurationSchedule.findOne({
      where: {
        curationId,
        weekStart: weekStartDate,
        listType,
        isActive: true
      }
    });

    if (existingSchedule) {
      return res.status(409).json({error: 'This curation is already scheduled for this week and list type'});
    }

    // Find the highest position in the current week and list type, then add to the end
    const maxPositionSchedule = await CurationSchedule.findOne({
      where: {
        weekStart: weekStartDate,
        listType,
        isActive: true
      },
      order: [['position', 'DESC']]
    });

    const nextPosition = maxPositionSchedule ? maxPositionSchedule.position + 1 : 0;

    // Validate that we don't exceed the maximum allowed positions (20)
    if (nextPosition >= 20) {
      return res.status(400).json({error: 'Maximum number of curations (20) reached for this week and list type'});
    }

    const schedule = await CurationSchedule.create({
      curationId,
      weekStart: weekStartDate,
      listType,
      position: nextPosition,
      scheduledBy,
      isActive: true,
    });

    // Fetch the complete schedule with related data
    const completeSchedule = await CurationSchedule.findByPk(schedule.id, {
      include: [
        {
          model: Curation,
          as: 'scheduledCuration',
          include: [
            {
              model: CurationType,
              as: 'types',
              through: { attributes: [] },
            },
            {
              model: Level,
              as: 'level',
              include: [
                {
                  model: Difficulty,
                  as: 'difficulty',
                },
                {
                  model: LevelCredit,
                  as: 'levelCredits',
                  include: [{
                    model: Creator,
                    as: 'creator',
                  }],
                }

              ],
            },
          ],
        },
      ],
    });

    const serializedSchedule = completeSchedule
      ? {
          ...completeSchedule.toJSON(),
          scheduledCuration: completeSchedule.scheduledCuration
            ? serializeCurationRow(completeSchedule.scheduledCuration)
            : null,
        }
      : null;

    return res.status(201).json(serializedSchedule);
  } catch (error) {
    logger.error('Error creating curation schedule:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
  }
);

// Update curation schedule
router.put(
  '/schedules/:id([0-9]{1,20})',
  Auth.headCurator(),
  ApiDoc({
    operationId: 'putAdminCurationSchedule',
    summary: 'Update curation schedule',
    description: 'Update schedule. Body: isActive?. Head curator.',
    tags: ['Admin', 'Curations'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    requestBody: { description: 'isActive', schema: { type: 'object', properties: { isActive: { type: 'boolean' } } }, required: true },
    responses: { 200: { description: 'Schedule updated' }, ...standardErrorResponses404500 },
  }),
  async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    const schedule = await CurationSchedule.findByPk(id);
    if (!schedule) {
      return res.status(404).json({error: 'Curation schedule not found'});
    }

    await schedule.update({
      isActive: isActive !== undefined ? isActive : schedule.isActive,
    });

    return res.json(schedule);
  } catch (error) {
    logger.error('Error updating curation schedule:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
  }
);

// Delete curation schedule
router.delete(
  '/schedules/:id([0-9]{1,20})',
  Auth.headCurator(),
  ApiDoc({
    operationId: 'deleteAdminCurationSchedule',
    summary: 'Delete curation schedule',
    description: 'Delete schedule. Head curator.',
    tags: ['Admin', 'Curations'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 204: { description: 'Schedule deleted' }, ...standardErrorResponses404500 },
  }),
  async (req, res) => {
  try {
    const { id } = req.params;

    const schedule = await CurationSchedule.findByPk(id);
    if (!schedule) {
      return res.status(404).json({error: 'Curation schedule not found'});
    }

    await schedule.destroy();
    return res.status(204).json({success: true, message: 'Curation schedule deleted successfully'});
  } catch (error) {
    logger.error('Error deleting curation schedule:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
  }
);

// Upload level thumbnail
router.post(
  '/:id([0-9]{1,20})/thumbnail',
  [requireCurationManagementPermission, upload.single('thumbnail')],
  ApiDoc({
    operationId: 'postAdminCurationThumbnail',
    summary: 'Upload curation thumbnail',
    description: 'Upload thumbnail for curation. Requires curation management permission.',
    tags: ['Admin', 'Curations'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    requestBody: { description: 'multipart/form-data with thumbnail file', schema: { type: 'object' }, required: true },
    responses: { 200: { description: 'Thumbnail uploaded' }, 400: { schema: errorResponseSchema }, ...standardErrorResponses403404500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const {id} = req.params;

    if (!req.file) {
      return res.status(400).json({error: 'No thumbnail file uploaded'});
    }

    const curation = await Curation.findByPk(id);
    if (!curation) {
      return res.status(404).json({error: 'Curation not found'});
    }

    // Delete existing thumbnail first if it exists
    if (curation.previewLink && isCdnUrl(curation.previewLink)) {
      const existingFileId = getFileIdFromCdnUrl(curation.previewLink);

      if (existingFileId) {
        try {
          logger.debug(`Deleting existing thumbnail ${existingFileId} before uploading new one`);
          await CdnService.deleteFile(existingFileId);
          logger.debug(`Successfully deleted existing thumbnail ${existingFileId}`);
        } catch (deleteError) {
          logger.error('Error deleting existing thumbnail:', deleteError);
          // Continue with upload even if deletion fails
        }
      }
    }

    // Upload new thumbnail to CDN
    const filename = `level_thumbnail_${id}_${Date.now()}.${req.file.originalname.split('.').pop()}`;
    const cdnResult = await CdnService.uploadLevelThumbnail(req.file.buffer, filename);

    // Update curation with new thumbnail URL
    await curation.update({
      previewLink: cdnResult.urls.original || cdnResult.urls.medium
    });



    return res.json({
      success: true,
      previewLink: curation.previewLink,
      cdnData: cdnResult
    });
  } catch (error) {
    logger.error('Error uploading level thumbnail:', error);
    return res.status(500).json({error: 'Failed to upload thumbnail'});
  }
  }
);

// Delete level thumbnail
router.delete(
  '/:id([0-9]{1,20})/thumbnail',
  requireCurationManagementPermission,
  ApiDoc({
    operationId: 'deleteAdminCurationThumbnail',
    summary: 'Delete curation thumbnail',
    description: 'Remove thumbnail from curation. Requires curation management permission.',
    tags: ['Admin', 'Curations'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: { 200: { description: 'Thumbnail removed' }, ...standardErrorResponses403404500 },
  }),
  async (req: Request, res: Response) => {
  let transaction: any;

  try {
    transaction = await sequelize.transaction();
    const {id} = req.params;

    const curation = await Curation.findByPk(id, { transaction });
    if (!curation) {
      await safeTransactionRollback(transaction);
      return res.status(404).json({error: 'Curation not found'});
    }

    // Clean up CDN files for this curation
    await cleanupCurationCdnFiles([curation]);

    // Clear the preview link
    await curation.update({previewLink: null}, { transaction });

    await transaction.commit();

    return res.json({success: true, message: 'Thumbnail removed successfully'});
  } catch (error) {
    await safeTransactionRollback(transaction);
    logger.error('Error deleting level thumbnail:', error);
    return res.status(500).json({error: 'Failed to delete thumbnail'});
  }
  }
);

export default router;
