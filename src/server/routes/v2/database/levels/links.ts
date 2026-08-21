import {Router, Request, Response} from 'express';
import Level from '@/models/levels/Level.js';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {Cache, CacheInvalidation} from '@/server/middleware/cache.js';
import {
  errorResponseSchema,
  standardErrorResponses,
  standardErrorResponses404500,
  idParamSpec,
} from '@/server/schemas/v2/database/levels/index.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {hasFlag} from '@/misc/utils/auth/permissionUtils.js';
import {permissionFlags} from '@/config/constants.js';
import {
  addLink,
  getLinkedLevels,
  LevelLinkError,
  removeMember,
} from '@/server/services/levels/levelLinkService.js';

const router = Router();

const linkedLevelsResponseSchema = {
  type: 'object',
  properties: {
    groupId: {type: 'integer'},
    levels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: {type: 'integer'},
          song: {type: 'string'},
          artist: {type: 'string'},
          suffix: {type: 'string'},
          diffId: {type: 'integer'},
          isDeleted: {type: 'boolean'},
          isHidden: {type: 'boolean'},
          difficulty: {type: 'object'},
        },
      },
    },
  },
};

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    if (parsed > 0) return parsed;
  }
  return null;
}

async function invalidateLinkedLevelCaches(levelIds: number[]): Promise<void> {
  const tags = [...new Set(levelIds)].map((id) => `level:${id}`);
  tags.push('levels:all');
  await CacheInvalidation.invalidateTags(tags);
}

function sendLinkError(res: Response, error: unknown): Response | void {
  if (error instanceof LevelLinkError) {
    return res.status(error.statusCode).json({error: error.message});
  }
  logger.error('Level link error:', error);
  return res.status(500).json({error: 'Failed to update level links'});
}

router.get(
  '/:id([0-9]{1,20})/links',
  Auth.addUserToRequest(),
  ApiDoc({
    operationId: 'getLevelLinks',
    summary: 'Get linked levels',
    description:
      'Returns the group of levels manually linked as minor variants of this chart. Empty if ungrouped.',
    tags: ['Levels'],
    security: ['bearerAuth'],
    params: {id: idParamSpec},
    responses: {
      200: {description: 'Linked levels', schema: linkedLevelsResponseSchema},
      ...standardErrorResponses404500,
    },
  }),
  Cache({
    ttl: 300,
    varyByRole: true,
    tags: (req) => [`level:${req.params.id}`, 'levels:all'],
  }),
  async (req: Request, res: Response) => {
    try {
      const levelId = parsePositiveInt(req.params.id);
      if (levelId == null) {
        return res.status(400).json({error: 'Invalid level ID'});
      }

      const level = await Level.findByPk(levelId, {attributes: ['id']});
      if (!level) {
        return res.status(404).json({error: 'Level not found'});
      }

      const includeHidden = Boolean(
        req.user && hasFlag(req.user, permissionFlags.SUPER_ADMIN),
      );
      const result = await getLinkedLevels(levelId, {includeHidden});
      return res.json(result);
    } catch (error) {
      logger.error('Error fetching level links:', error);
      return res.status(500).json({error: 'Failed to fetch level links'});
    }
  },
);

router.post(
  '/:id([0-9]{1,20})/links',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postLevelLinks',
    summary: 'Link a level',
    description:
      'Join another level into this level\'s link group. Merges groups when the other level already belongs to a different group.',
    tags: ['Levels'],
    security: ['bearerAuth'],
    params: {id: idParamSpec},
    requestBody: {
      description: 'levelId of the level to join into this group',
      schema: {
        type: 'object',
        properties: {levelId: {type: 'integer'}},
        required: ['levelId'],
      },
    },
    responses: {
      200: {description: 'Updated link group', schema: linkedLevelsResponseSchema},
      ...standardErrorResponses,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const levelId = parsePositiveInt(req.params.id);
      const otherLevelId = parsePositiveInt(req.body?.levelId);
      if (levelId == null || otherLevelId == null) {
        return res.status(400).json({error: 'Invalid level ID'});
      }

      const {affectedLevelIds} = await addLink(levelId, otherLevelId);
      await invalidateLinkedLevelCaches(affectedLevelIds);
      const result = await getLinkedLevels(levelId, {includeHidden: true});
      return res.json(result);
    } catch (error) {
      return sendLinkError(res, error);
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/links/:memberLevelId([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'deleteLevelLinkMember',
    summary: 'Unlink a level from a group',
    description:
      'Remove a member from this level\'s link group. Dissolves the group when fewer than two members remain.',
    tags: ['Levels'],
    security: ['bearerAuth'],
    params: {
      id: idParamSpec,
      memberLevelId: {description: 'Level ID to remove from the group', schema: {type: 'string'}},
    },
    responses: {
      200: {description: 'Updated link group', schema: linkedLevelsResponseSchema},
      400: {schema: errorResponseSchema},
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const levelId = parsePositiveInt(req.params.id);
      const memberLevelId = parsePositiveInt(req.params.memberLevelId);
      if (levelId == null || memberLevelId == null) {
        return res.status(400).json({error: 'Invalid level ID'});
      }

      const {affectedLevelIds} = await removeMember(levelId, memberLevelId);
      await invalidateLinkedLevelCaches(affectedLevelIds);
      const result = await getLinkedLevels(levelId, {includeHidden: true});
      return res.json(result);
    } catch (error) {
      return sendLinkError(res, error);
    }
  },
);

export default router;
