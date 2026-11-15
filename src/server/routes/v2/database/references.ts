import {Request, Response, Router} from 'express';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { errorResponseSchema, standardErrorResponses, standardErrorResponses401500, standardErrorResponses404500, standardErrorResponses500, idParamSpec } from '@/server/schemas/v2/database/index.js';
import {Op, Transaction} from 'sequelize';
import Reference from '@/models/levels/References.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Level from '@/models/levels/Level.js';
import {Auth} from '@/server/middleware/auth.js';
import sequelize from '@/config/db.js';
import { logger } from '@/server/services/core/LoggerService.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Creator from '@/models/credits/Creator.js';
import Team from '@/models/credits/Team.js';
import { Cache, CacheInvalidation } from '@/server/middleware/cache.js';
import { sortLevelCredits } from '@/misc/utils/Utility.js';
import { isWatchablePguDifficultyName } from '@/server/services/references/pguDifficulty.js';
import {
  listWatchDifficultyIds,
  ReferenceWatchError,
  setDifficultyWatch,
  setGroupWatch,
} from '@/server/services/references/referenceWatchService.js';
import { emitReferenceChanged } from '@/server/services/references/referenceChangeEmit.js';

interface ILevelWithReference extends Level {
  reference?: {
    type: string | null;
  };
}

interface IReferenceUpdate {
  levelId: number;
  type: string;
}

const router: Router = Router();

// Get all references grouped by difficulty
router.get(
  '/',
  ApiDoc({
    operationId: 'getReferences',
    summary: 'List all references',
    description: 'Returns references grouped by PGU difficulty (cached).',
    tags: ['Database', 'References'],
    responses: { 200: { description: 'References by difficulty' }, ...standardErrorResponses500 },
  }),
  Cache({
  ttl: 60*60*24*7, // week
  tags: ['references:all'] // Tag all list queries
}),
  async (req: Request, res: Response) => {
  try {
    // First get all difficulties with their references
    const difficulties = await Difficulty.findAll({
      where: {
        type: 'PGU', // Only get PGU difficulties
      },
      include: [
        {
          model: Level,
          as: 'referenceLevels',
          include: [{
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
          through: {
            attributes: ['type'], // Include the type from the Reference model
            as: 'reference' // This will be the name of the property containing the reference data
          },
          where: {
            isDeleted: false, // Only include non-deleted levels
          },
          required: false, // LEFT JOIN to include difficulties without levels
        },
      ],
      order: [
        ['sortOrder', 'ASC'], // Order difficulties by their sort order
        [{model: Level, as: 'referenceLevels'}, 'id', 'ASC'], // Order levels by ID
      ],
    }).then(difficulties => {
      return difficulties.filter(diff => isWatchablePguDifficultyName(diff.name));
    });

    // Transform the data into a more usable format
    const formattedReferences = difficulties.map(diff => ({
      difficulty: diff,
      levels: (diff.referenceLevels as ILevelWithReference[]).map(level => {
        const json = level.toJSON();
        return {
          ...json,
          levelCredits: sortLevelCredits(json.levelCredits),
          type: level.reference?.type || '' // Get the type from the reference, default to empty string
        };
      }),
    }));

    return res.json(formattedReferences);
  } catch (error) {
    logger.error('Error fetching references:', error);
    return res.status(500).json({error: 'Failed to fetch references'});
  }
  }
);

// Get references for a specific difficulty
router.get(
  '/difficulty/:difficultyId([0-9]{1,20})',
  ApiDoc({
    operationId: 'getReferencesByDifficulty',
    summary: 'References by difficulty',
    description: 'Returns reference levels for a difficulty (cached).',
    tags: ['Database', 'References'],
    params: { difficultyId: { schema: { type: 'string' } } },
    responses: { 200: { description: 'Reference levels' }, ...standardErrorResponses404500 },
  }),
  Cache({
  ttl: 60*60*24*7, // week
  tags: ['references:difficulty'] // Tag all list queries
}),
  async (req: Request, res: Response) => {
  try {
    const {difficultyId} = req.params;

    const difficulty = await Difficulty.findByPk(parseInt(difficultyId), {
      include: [
        {
          model: Level,
          as: 'referenceLevels',
          include: [{
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
          through: {
            attributes: ['type'],
            as: 'reference'
          },
          where: {
            isDeleted: false,
          },
          required: false,
        },
      ],
    });

    if (!difficulty) {
      return res.status(404).json({error: 'Difficulty not found'});
    }

    const formattedReference = {
      difficulty,
      levels: (difficulty.referenceLevels as ILevelWithReference[]).map(level => {
        const json = level.toJSON();
        return {
          ...json,
          levelCredits: sortLevelCredits(json.levelCredits),
          type: level.reference?.type || ''
        };
      }),
    };

    return res.json(formattedReference);
  } catch (error) {
    logger.error('Error fetching references by difficulty:', error);
    return res.status(500).json({error: 'Failed to fetch references'});
  }
  }
);

// Get references by level ID
router.get(
  '/level/:levelId([0-9]{1,20})',
  ApiDoc({
    operationId: 'getReferencesByLevel',
    summary: 'References by level',
    description: 'Returns references (difficulty links) for a level (cached).',
    tags: ['Database', 'References'],
    params: { levelId: { schema: { type: 'string' } } },
    responses: { 200: { description: 'References list' }, ...standardErrorResponses500 },
  }),
  Cache({
  ttl: 60*60*24*7, // week
  tags: ['references:level']
}),
  async (req: Request, res: Response) => {
  try {
    const {levelId} = req.params;
    const references = await Reference.findAll({
      where: {levelId: parseInt(levelId)},
      include: [
        {
          model: Difficulty,
          as: 'difficultyReference',
        },
      ],
    });
    return res.json(references);
  } catch (error) {
    logger.error('Error fetching references by level:', error);
    return res.status(500).json({error: 'Failed to fetch references'});
  }
  }
);

router.get(
  '/watches',
  Auth.user(),
  ApiDoc({
    operationId: 'getReferenceWatches',
    summary: 'List watched reference difficulties',
    description: 'Returns PGU difficulty ids the signed-in user is watching.',
    tags: ['Database', 'References'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'difficultyIds' }, ...standardErrorResponses401500 },
  }),
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({error: 'User not authenticated'});
    try {
      const difficultyIds = await listWatchDifficultyIds(userId);
      return res.json({difficultyIds});
    } catch (error) {
      logger.error('Error fetching reference watches:', error);
      return res.status(500).json({error: 'Failed to fetch reference watches'});
    }
  },
);

router.put(
  '/watches/group',
  Auth.user(),
  ApiDoc({
    operationId: 'putReferenceWatchesGroup',
    summary: 'Watch or unwatch a PGU group',
    description: 'Insert or remove watches for every P/G/U difficulty in the group.',
    tags: ['Database', 'References'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'group and watched',
      schema: {
        type: 'object',
        properties: { group: { type: 'string', enum: ['P', 'G', 'U'] }, watched: { type: 'boolean' } },
        required: ['group', 'watched'],
      },
      required: true,
    },
    responses: { 200: { description: 'difficultyIds' }, ...standardErrorResponses401500 },
  }),
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({error: 'User not authenticated'});
    if (typeof req.body?.watched !== 'boolean') {
      return res.status(400).json({error: 'watched must be a boolean'});
    }
    try {
      const difficultyIds = await setGroupWatch(userId, String(req.body.group ?? ''), req.body.watched);
      return res.json({difficultyIds});
    } catch (error) {
      if (error instanceof ReferenceWatchError) {
        return res.status(error.status).json({error: error.message});
      }
      logger.error('Error updating reference watch group:', error);
      return res.status(500).json({error: 'Failed to update reference watches'});
    }
  },
);

router.put(
  '/watches/:difficultyId([0-9]{1,20})',
  Auth.user(),
  ApiDoc({
    operationId: 'putReferenceWatch',
    summary: 'Watch or unwatch a difficulty',
    description: 'Insert or remove a watch for one PGU difficulty.',
    tags: ['Database', 'References'],
    security: ['bearerAuth'],
    params: { difficultyId: { schema: { type: 'string' } } },
    requestBody: {
      description: 'watched',
      schema: { type: 'object', properties: { watched: { type: 'boolean' } }, required: ['watched'] },
      required: true,
    },
    responses: { 200: { description: 'difficultyIds' }, ...standardErrorResponses401500 },
  }),
  async (req: Request, res: Response) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({error: 'User not authenticated'});
    if (typeof req.body?.watched !== 'boolean') {
      return res.status(400).json({error: 'watched must be a boolean'});
    }
    try {
      const difficultyIds = await setDifficultyWatch(
        userId,
        parseInt(req.params.difficultyId, 10),
        req.body.watched,
      );
      return res.json({difficultyIds});
    } catch (error) {
      if (error instanceof ReferenceWatchError) {
        return res.status(error.status).json({error: error.message});
      }
      logger.error('Error updating reference watch:', error);
      return res.status(500).json({error: 'Failed to update reference watch'});
    }
  },
);

// Create a new reference
router.post(
  '/',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postReference',
    summary: 'Create reference',
    description: 'Create a difficulty reference level (super admin).',
    tags: ['Database', 'References'],
    security: ['bearerAuth'],
    requestBody: { description: 'difficultyId, levelId, type', schema: { type: 'object', properties: { difficultyId: { type: 'integer' }, levelId: { type: 'integer' }, type: { type: 'string' } }, required: ['difficultyId', 'levelId', 'type'] }, required: true },
    responses: { 201: { description: 'Created reference' }, 409: { schema: errorResponseSchema }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const {difficultyId, levelId, type} = req.body;

    // Check if reference already exists
    const existingReference = await Reference.findOne({
      where: {
        difficultyId,
        levelId,
      },
    });

    if (existingReference) {
      return res.status(409).json({error: 'Reference already exists'});
    }

    // Create new reference
    const reference = await Reference.create({
      difficultyId,
      levelId,
      type,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    try {
      await emitReferenceChanged({
        kind: 'added',
        levelId: Number(levelId),
        difficultyIds: [Number(difficultyId)],
        type: type ?? null,
        actorId: req.user?.id ?? null,
      });
    } catch (emitError) {
      logger.error('Error emitting reference added:', emitError);
    }

    return res.status(201).json(reference);
  } catch (error) {
    logger.error('Error creating reference:', error);
    return res.status(500).json({error: 'Failed to create reference'});
  }
  }
);

// Update a reference
router.put(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'putReference',
    summary: 'Update reference',
    description: 'Update a reference by ID (super admin).',
    tags: ['Database', 'References'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: { description: 'difficultyId, levelId, type', schema: { type: 'object', properties: { difficultyId: { type: 'integer' }, levelId: { type: 'integer' }, type: { type: 'string' } } }, required: true },
    responses: { 200: { description: 'Updated reference' }, ...standardErrorResponses404500, 409: { schema: errorResponseSchema } },
  }),
  async (req: Request, res: Response) => {
  try {
    const {id} = req.params;
    const {difficultyId, levelId, type} = req.body;

    const reference = await Reference.findByPk(id);
    if (!reference) {
      return res.status(404).json({error: 'Reference not found'});
    }

    // Check if the new combination already exists
    const existingReference = await Reference.findOne({
      where: {
        difficultyId,
        levelId,
        id: {[Op.ne]: id}, // Exclude current reference
      },
    });

    if (existingReference) {
      return res
        .status(409)
        .json({error: 'Reference with these IDs already exists'});
    }

    const previousDifficultyId = Number(reference.difficultyId);
    const previousLevelId = Number(reference.levelId);
    const previousType = reference.type ?? null;

    await reference.update({
      difficultyId,
      levelId,
      type,
      updatedAt: new Date(),
    });

    const nextDifficultyId = Number(difficultyId);
    const nextLevelId = Number(levelId);
    const actorId = req.user?.id ?? null;
    try {
      if (previousDifficultyId !== nextDifficultyId || previousLevelId !== nextLevelId) {
        await emitReferenceChanged({
          kind: 'removed',
          levelId: previousLevelId,
          difficultyIds: [previousDifficultyId],
          type: previousType,
          actorId,
        });
        await emitReferenceChanged({
          kind: 'added',
          levelId: nextLevelId,
          difficultyIds: [nextDifficultyId],
          type: type ?? null,
          actorId,
        });
      } else if ((previousType ?? '') !== (type ?? '')) {
        await emitReferenceChanged({
          kind: 'type',
          levelId: nextLevelId,
          difficultyIds: [nextDifficultyId],
          type: type ?? null,
          previousType,
          actorId,
        });
      }
    } catch (emitError) {
      logger.error('Error emitting reference update:', emitError);
    }

    return res.json(reference);
  } catch (error) {
    logger.error('Error updating reference:', error);
    return res.status(500).json({error: 'Failed to update reference'});
  }
  }
);

// Delete a reference
router.delete(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'deleteReference',
    summary: 'Delete reference',
    description: 'Delete a reference by ID (super admin).',
    tags: ['Database', 'References'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: { 200: { description: 'Reference deleted' }, ...standardErrorResponses404500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const {id} = req.params;
      const reference = await Reference.findByPk(id);

      if (!reference) {
        return res.status(404).json({error: 'Reference not found'});
      }

      const removedLevelId = Number(reference.levelId);
      const removedDifficultyId = Number(reference.difficultyId);
      const removedType = reference.type ?? null;
      await reference.destroy();
      try {
        await emitReferenceChanged({
          kind: 'removed',
          levelId: removedLevelId,
          difficultyIds: [removedDifficultyId],
          type: removedType,
          actorId: req.user?.id ?? null,
        });
      } catch (emitError) {
        logger.error('Error emitting reference removed:', emitError);
      }
      return res.json({message: 'Reference deleted successfully'});
    } catch (error) {
      logger.error('Error deleting reference:', error);
      return res.status(500).json({error: 'Failed to delete reference'});
    }
  },
);

// Bulk update references for a difficulty
router.put(
  '/bulk/:difficultyId([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'putReferencesBulk',
    summary: 'Bulk update references',
    description: 'Replace references for a difficulty with the given list (super admin).',
    tags: ['Database', 'References'],
    security: ['bearerAuth'],
    params: { difficultyId: { schema: { type: 'string' } } },
    requestBody: { description: 'references: array of { levelId, type }', schema: { type: 'object', properties: { references: { type: 'array', items: { type: 'object', properties: { levelId: { type: 'integer' }, type: { type: 'string' } } } } }, required: ['references'] }, required: true },
    responses: { 200: { description: 'added, removed, updated counts' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
  try {
    const { difficultyId } = req.params;
    const { references } = req.body as { references: IReferenceUpdate[] };

    // Start a transaction to ensure all operations succeed or none do
    const result = await sequelize.transaction(async (t: Transaction) => {
      // Get current references for this difficulty
      const currentRefs = await Reference.findAll({
        where: { difficultyId: parseInt(difficultyId) },
        transaction: t
      });

      // Create maps for easier lookup
      const currentRefMap = new Map(currentRefs.map(ref => [ref.levelId, ref]));
      const newRefMap = new Map(references.map(ref => [ref.levelId, ref]));

      // Find references to add and remove
      const toAdd = references.filter(ref => !currentRefMap.has(ref.levelId));
      const toRemove = currentRefs.filter(ref => !newRefMap.has(ref.levelId));
      const toUpdate = references.filter(ref =>
        currentRefMap.has(ref.levelId) &&
        currentRefMap.get(ref.levelId)?.type !== ref.type
      );

      // Remove references that are no longer needed
      await Promise.all(toRemove.map(ref => ref.destroy({ transaction: t })));

      // Add new references
      await Promise.all(toAdd.map(ref =>
        Reference.create({
          difficultyId: parseInt(difficultyId),
          levelId: ref.levelId,
          type: ref.type,
          createdAt: new Date(),
          updatedAt: new Date()
        }, { transaction: t })
      ));

      // Update existing references
      await Promise.all(toUpdate.map(ref =>
        currentRefMap.get(ref.levelId)?.update({
          type: ref.type,
          updatedAt: new Date()
        }, { transaction: t })
      ));

      return {
        added: toAdd.length,
        removed: toRemove.length,
        updated: toUpdate.length,
        toAdd,
        toRemove: toRemove.map((ref) => ({
          levelId: Number(ref.levelId),
          type: ref.type ?? null,
        })),
        toUpdate: toUpdate.map((ref) => ({
          levelId: ref.levelId,
          type: ref.type,
          previousType: currentRefMap.get(ref.levelId)?.type ?? null,
        })),
      };
    });

    const diffId = parseInt(difficultyId, 10);
    const actorId = req.user?.id ?? null;
    try {
      for (const ref of result.toAdd) {
        await emitReferenceChanged({
          kind: 'added',
          levelId: ref.levelId,
          difficultyIds: [diffId],
          type: ref.type ?? null,
          actorId,
        });
      }
      for (const ref of result.toRemove) {
        await emitReferenceChanged({
          kind: 'removed',
          levelId: ref.levelId,
          difficultyIds: [diffId],
          type: ref.type,
          actorId,
        });
      }
      for (const ref of result.toUpdate) {
        await emitReferenceChanged({
          kind: 'type',
          levelId: ref.levelId,
          difficultyIds: [diffId],
          type: ref.type ?? null,
          previousType: ref.previousType,
          actorId,
        });
      }
    } catch (emitError) {
      logger.error('Error emitting bulk reference changes:', emitError);
    }

    return res.json({
      added: result.added,
      removed: result.removed,
      updated: result.updated,
    });
  } catch (error) {
    logger.error('Error bulk updating references:', error);
    return res.status(500).json({ error: 'Failed to bulk update references' });
  }
  }
);


// =============== CACHE CONTROL =================

const invalidateReferencesCache = async () => {
  await CacheInvalidation.invalidateTags(['references:all']);
  await CacheInvalidation.invalidateTags(['references:difficulty']);
  await CacheInvalidation.invalidateTags(['references:level']);
};

Reference.afterBulkCreate('cacheInvalidationReferenceBulkCreate', async () => {
  await invalidateReferencesCache();
});

Reference.afterBulkUpdate('cacheInvalidationReferenceBulkUpdate', async () => {
  await invalidateReferencesCache();
});

Reference.afterBulkDestroy('cacheInvalidationReferenceBulkDestroy', async () => {
  await invalidateReferencesCache();
});

Reference.afterDestroy('cacheInvalidationReferenceDestroy', async () => {
  await invalidateReferencesCache();
});

Reference.afterUpdate('cacheInvalidationReferenceUpdate', async () => {
  await invalidateReferencesCache();
});

Reference.afterCreate('cacheInvalidationReferenceCreate', async () => {
  await invalidateReferencesCache();
});

export default router;
