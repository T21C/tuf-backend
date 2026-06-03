import { Op } from 'sequelize';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { standardErrorResponses500 } from '@/server/schemas/v2/database/levels/index.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Level from '@/models/levels/Level.js';
import LevelAnnouncementQueue from '@/models/levels/LevelAnnouncementQueue.js';
import { Router, Request, Response } from 'express';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Team from '@/models/credits/Team.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  buildCurveScoreSampleLines,
  formatCurveScoreSamplesSection,
} from '@/server/routes/v2/webhooks/rerateEmbedSections.js';

const router: Router = Router();

const levelInclude = [
  { model: Difficulty, as: 'difficulty' },
  { model: Difficulty, as: 'previousDifficulty' },
  { model: LevelCredit, as: 'levelCredits' },
  { model: Team, as: 'teamObject' },
];

async function enrichQueueRows(rows: LevelAnnouncementQueue[]) {
  return Promise.all(
    rows.map(async row => {
      const level = row.level;
      let curvePreview: string | null = null;
      if (row.facets?.includes('CURVE') && level) {
        const lines = await buildCurveScoreSampleLines(level.id, row.before, row.after);
        curvePreview = formatCurveScoreSamplesSection(lines);
      }
      return {
        queueRowId: row.id,
        kind: row.kind,
        facets: row.facets,
        before: row.before,
        after: row.after,
        enqueuedAt: row.createdAt,
        level,
        curvePreview,
      };
    }),
  );
}

router.get(
  '/unannounced/new',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'getLevelsUnannouncedNew',
    summary: 'List unannounced new levels',
    description: 'Pending NEW queue rows (super admin)',
    tags: ['Levels', 'Admin'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'List of queue entries' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const rows = await LevelAnnouncementQueue.findAll({
        where: {
          status: 'PENDING',
          kind: 'NEW',
        },
        include: [
          {
            model: Level,
            as: 'level',
            where: { isDeleted: false, diffId: { [Op.ne]: 0 } },
            required: true,
            include: [{ model: Difficulty, as: 'difficulty' }],
          },
        ],
        order: [['createdAt', 'DESC']],
      });

      return res.json(await enrichQueueRows(rows));
    } catch (error) {
      logger.error('Error fetching unannounced new levels:', error);
      return res
        .status(500)
        .json({error: 'Failed to fetch unannounced new levels'});
    }
  }
);

router.get(
  '/unannounced/rerates',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'getLevelsUnannouncedRerates',
    summary: 'List unannounced rerates',
    description: 'Pending RERATE queue rows (super admin)',
    tags: ['Levels', 'Admin'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'List of queue entries' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const rows = await LevelAnnouncementQueue.findAll({
        where: {
          status: 'PENDING',
          kind: 'RERATE',
        },
        include: [
          {
            model: Level,
            as: 'level',
            where: { isDeleted: false, diffId: { [Op.ne]: 0 } },
            required: true,
            include: levelInclude,
          },
        ],
        order: [['createdAt', 'DESC']],
      });

      return res.json(await enrichQueueRows(rows));
    } catch (error) {
      logger.error('Error fetching unannounced rerates:', error);
      return res.status(500).json({error: 'Failed to fetch unannounced rerates'});
    }
  }
);

export default router;
