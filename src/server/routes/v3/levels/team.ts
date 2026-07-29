import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {
  idParamSpec,
  standardErrorResponses404500,
} from '@/server/schemas/common.js';
import sequelize from '@/config/db.js';
import {safeTransactionRollback} from '@/misc/utils/Utility.js';
import {logger} from '@/server/services/core/LoggerService.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {
  clearLevelTeam,
  setLevelTeam,
  TeamMutationError,
} from '@/server/services/teams/teamMutations.js';

const router: Router = Router();
const elasticsearchService = ElasticsearchService.getInstance();

function handleTeamError(res: Response, error: unknown, logLabel: string) {
  if (error instanceof TeamMutationError) {
    return res.status(error.status).json({error: error.message, ...error.extra});
  }
  logger.error(logLabel, error);
  return res.status(500).json({
    error: 'Failed to process level team request',
    details: error instanceof Error ? error.message : String(error),
  });
}

router.put(
  '/:id([0-9]{1,20})/team',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'v3PutLevelTeam',
    summary: 'Set level team (v3)',
    description:
      'Assign or create a team for a level. Body: teamId?, name?, members?. Prefer over /v2/database/creators/level/:id/team. Super admin.',
    tags: ['Database', 'Levels', 'Teams', 'v3'],
    security: ['bearerAuth'],
    params: {id: idParamSpec},
    requestBody: {
      description: 'teamId, name, members',
      schema: {
        type: 'object',
        properties: {
          teamId: {type: 'number'},
          name: {type: 'string'},
          members: {type: 'array', items: {type: 'number'}},
        },
      },
      required: true,
    },
    responses: {200: {description: 'Team updated'}, ...standardErrorResponses404500},
  }),
  async (req: Request, res: Response) => {
    let transaction: Awaited<ReturnType<typeof sequelize.transaction>> | undefined;
    try {
      const levelId = parseInt(req.params.id, 10);
      if (!Number.isFinite(levelId)) {
        return res.status(400).json({error: 'Invalid level id'});
      }
      transaction = await sequelize.transaction();
      const team = await setLevelTeam(
        levelId,
        {
          teamId: req.body?.teamId,
          name: req.body?.name,
          members: req.body?.members,
        },
        transaction,
      );
      await transaction.commit();
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      elasticsearchService.indexLevel(levelId);
      return res.json({
        message: 'Team updated successfully',
        team,
      });
    } catch (error) {
      await safeTransactionRollback(transaction);
      return handleTeamError(res, error, '[v3 PUT /levels/:id/team] failure');
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})/team',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'v3DeleteLevelTeam',
    summary: 'Remove level team (v3)',
    description:
      'Remove team association from level. Deletes the team when unused elsewhere. Prefer over /v2/database/creators/level/:id/team. Super admin.',
    tags: ['Database', 'Levels', 'Teams', 'v3'],
    security: ['bearerAuth'],
    params: {id: idParamSpec},
    responses: {200: {description: 'Team removed'}, ...standardErrorResponses404500},
  }),
  async (req: Request, res: Response) => {
    let transaction: Awaited<ReturnType<typeof sequelize.transaction>> | undefined;
    try {
      const levelId = parseInt(req.params.id, 10);
      if (!Number.isFinite(levelId)) {
        return res.status(400).json({error: 'Invalid level id'});
      }
      transaction = await sequelize.transaction();
      await clearLevelTeam(levelId, transaction);
      await transaction.commit();
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      elasticsearchService.indexLevel(levelId);
      return res.json({message: 'Team association removed successfully'});
    } catch (error) {
      await safeTransactionRollback(transaction);
      return handleTeamError(res, error, '[v3 DELETE /levels/:id/team] failure');
    }
  },
);

export default router;
