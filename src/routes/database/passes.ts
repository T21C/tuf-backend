import {Request, Response, Router} from 'express';
import {Op, OrderItem, WhereOptions} from 'sequelize';
import {escapeRegExp} from '../../misc/Utility';
import Pass from '../../models/Pass';
import Level from '../../models/Level';
import Player from '../../models/Player';
import Judgement from '../../models/Judgement';
import {Auth} from '../../middleware/auth';
import {getIO} from '../../utils/socket';
import {calcAcc} from '../../misc/CalcAcc';
import {getScoreV2} from '../../misc/CalcScore';
import sequelize from '../../config/db';
import {IPass as PassInterface} from '../../types/models';

const router: Router = Router();

type WhereClause = WhereOptions<PassInterface> & {
  isDeleted?: boolean;
  levelId?: number;
  is12K?: boolean;
  '$player.name$'?: {[Op.like]: string};
  '$level.legacyDiff$'?: {[Op.gte]: number} | {[Op.lte]: number};
  [Op.or]?: Array<{[key: string]: any}>;
};

// Helper function to build where clause
const buildWhereClause = (query: {
  deletedFilter?: string;
  lowDiff?: string;
  highDiff?: string;
  only12k?: string | boolean;
  levelId?: string;
  player?: string;
  query?: string;
}): WhereClause => {
  const where: WhereClause = {};

  // Handle deleted filter
  if (query.deletedFilter === 'hide') {
    where.isDeleted = false;
  } else if (query.deletedFilter === 'only') {
    where.isDeleted = true;
  }

  // Add difficulty range filter
  if (query.lowDiff) {
    where['$level.legacyDiff$'] = {
      [Op.gte]: Number(query.lowDiff),
    };
  }
  if (query.highDiff) {
    where['$level.legacyDiff$'] = {
      ...where['$level.legacyDiff$'],
      [Op.lte]: Number(query.highDiff),
    };
  }

  // Add 12k filter
  if (query.only12k === 'true' || query.only12k === true) {
    where.is12K = true;
  } else {
    where.is12K = false;
  }

  // Level ID filter
  if (query.levelId) {
    where.levelId = Number(query.levelId);
  }

  // Player name filter
  if (query.player) {
    where['$player.name$'] = {[Op.like]: `%${escapeRegExp(query.player)}%`};
  }

  // General search
  if (query.query) {
    const searchTerm = escapeRegExp(query.query);
    where[Op.or] = [
      {'$player.name$': {[Op.like]: `%${searchTerm}%`}},
      {'$level.song$': {[Op.like]: `%${searchTerm}%`}},
      {'$level.artist$': {[Op.like]: `%${searchTerm}%`}},
      {'$level.pguDiff$': {[Op.like]: `%${searchTerm}%`}},
      {levelId: {[Op.like]: `%${searchTerm}%`}},
      {id: {[Op.like]: `%${searchTerm}%`}},
    ];
  }

  return where;
};

// Get sort options
const getSortOptions = (sort?: string): OrderItem[] => {
  switch (sort) {
    case 'RECENT_ASC':
      return [['id', 'ASC']];
    case 'RECENT_DESC':
      return [['id', 'DESC']];
    case 'SCORE_ASC':
      return [
        ['scoreV2', 'ASC'],
        ['id', 'DESC'], // Secondary sort by newest first
      ];
    case 'SCORE_DESC':
      return [
        ['scoreV2', 'DESC'],
        ['id', 'DESC'], // Secondary sort by newest first
      ];
    case 'XACC_ASC':
      return [
        ['accuracy', 'ASC'],
        ['scoreV2', 'DESC'], // Secondary sort by highest score
        ['id', 'DESC'], // Tertiary sort by newest first
      ];
    case 'XACC_DESC':
      return [
        ['accuracy', 'DESC'],
        ['scoreV2', 'DESC'], // Secondary sort by highest score
        ['id', 'DESC'], // Tertiary sort by newest first
      ];
    case 'DIFF_ASC':
      return [
        [{model: Level, as: 'level'}, 'newDiff', 'ASC'],
        ['scoreV2', 'DESC'], // Secondary sort by highest score
        ['id', 'DESC'], // Tertiary sort by newest first
      ];
    case 'DIFF_DESC':
      return [
        [{model: Level, as: 'level'}, 'newDiff', 'DESC'],
        ['scoreV2', 'DESC'], // Secondary sort by highest score
        ['id', 'DESC'], // Tertiary sort by newest first
      ];
    case 'RANDOM':
      return [sequelize.random()];
    default:
      return [
        ['scoreV2', 'DESC'], // Default to highest score
        ['id', 'DESC'], // Secondary sort by newest first
      ];
  }
};

router.get('/level/:levelId', async (req: Request, res: Response) => {
  try {
    const {levelId} = req.params;

    const passes = await Pass.findAll({
      where: {
        levelId: parseInt(levelId),
        isDeleted: false,
        '$player.isBanned$': false,
      },
      include: [
        {
          model: Player,
          as: 'player',
          attributes: ['name', 'country', 'isBanned'],
        },
        {
          model: Level,
          as: 'level',
          attributes: ['song', 'artist', 'pguDiff', 'baseScore'],
        },
        {
          model: Judgement,
          as: 'judgements',
        },
      ],
    });

    return res.json(passes);
  } catch (error) {
    console.error('Error fetching passes:', error);
    return res.status(500).json({error: 'Failed to fetch passes'});
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();

    const passes = await Pass.findAll({
      where: buildWhereClause(req.query),
      include: [
        {
          model: Player,
          as: 'player',
          attributes: ['name', 'country', 'isBanned'],
          where: {isBanned: false},
        },
        {
          model: Level,
          as: 'level',
          attributes: ['song', 'artist', 'pguDiff', 'baseScore', 'newDiff'],
        },
        {
          model: Judgement,
          as: 'judgements',
        },
      ],
      order: getSortOptions(req.query.sort as string),
    });

    const count = passes.length;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const results = passes.slice(offset, limit ? offset + limit : undefined);

    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total route time: ${totalTime.toFixed(2)}ms`);

    return res.json({count, results});
  } catch (error) {
    console.error('Error fetching passes:', error);
    return res.status(500).json({error: 'Failed to fetch passes'});
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const pass = await Pass.findOne({
      where: {id: parseInt(req.params.id)},
      include: [
        {
          model: Player,
          as: 'player',
          attributes: ['name', 'country', 'isBanned'],
        },
        {
          model: Level,
          as: 'level',
          attributes: ['song', 'artist', 'pguDiff', 'baseScore'],
        },
        {
          model: Judgement,
          as: 'judgements',
        },
      ],
    });

    if (!pass) {
      return res.status(404).json({error: 'Pass not found'});
    }

    return res.json(pass);
  } catch (error) {
    console.error('Error fetching pass:', error);
    return res.status(500).json({error: 'Failed to fetch pass'});
  }
});

router.put('/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const {id} = req.params;
    const originalPass = await Pass.findOne({
      where: {id: parseInt(id)},
      include: [
        {
          model: Level,
          as: 'level',
        },
        {
          model: Judgement,
          as: 'judgements',
        },
      ],
      transaction,
    });

    if (!originalPass) {
      await transaction.rollback();
      return res.status(404).json({error: 'Pass not found'});
    }

    // Handle level change and clear count updates
    if (originalPass.levelId !== req.body.levelId) {
      await Promise.all([
        Level.decrement('clears', {
          where: {id: originalPass.levelId},
          transaction,
        }),
        Level.increment('clears', {
          where: {id: req.body.levelId},
          transaction,
        }),
      ]);
    }

    // Get the correct level for score calculation
    const level =
      originalPass.levelId !== req.body.levelId
        ? await Level.findByPk(req.body.levelId, {transaction}).then(
            level => level?.dataValues,
          )
        : originalPass.level?.dataValues;

    if (!level) {
      await transaction.rollback();
      return res.status(404).json({error: 'Level not found'});
    }

    // Calculate new accuracy and score
    const judgements = req.body.judgements;
    const accuracy = calcAcc(judgements);
    const scoreV2 = getScoreV2(
      {
        speed: req.body.speed,
        judgements,
        isNoHoldTap: req.body.isNoHoldTap,
      },
      {
        baseScore: level.baseScore || 0,
      },
    );

    // Update pass
    await Pass.update(
      {
        levelId: req.body.levelId,
        speed: req.body.speed,
        playerId: req.body.playerId,
        feelingRating: req.body.feelingRating,
        vidTitle: req.body.vidTitle,
        vidLink: req.body.vidLink,
        vidUploadTime: new Date(req.body.vidUploadTime),
        is12K: req.body.is12K,
        is16K: req.body.is16K,
        isNoHoldTap: req.body.isNoHoldTap,
        accuracy,
        scoreV2,
      },
      {
        where: {id: parseInt(id)},
        transaction,
      },
    );

    // Update judgements
    await Judgement.update(judgements, {
      where: {id: parseInt(id)},
      transaction,
    });

    // Fetch the updated pass
    const updatedPass = await Pass.findOne({
      where: {id: parseInt(id)},
      include: [
        {
          model: Level,
          as: 'level',
        },
        {
          model: Judgement,
          as: 'judgements',
        },
        {
          model: Player,
          as: 'player',
          attributes: ['id', 'name', 'country', 'isBanned'],
        },
      ],
      transaction,
    });

    await transaction.commit();

    const io = getIO();
    io.emit('passesUpdated');

    return res.json({
      message: 'Pass updated successfully',
      pass: updatedPass,
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error updating pass:', error);
    return res.status(500).json({error: 'Failed to update pass'});
  }
});

// Add soft delete endpoint
router.patch(
  '/:id/soft-delete',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const {id} = req.params;

      const pass = await Pass.findOne({
        where: {id: parseInt(id)},
        include: [
          {
            model: Level,
            as: 'level',
          },
        ],
        transaction,
      });

      if (!pass) {
        await transaction.rollback();
        return res.status(404).json({error: 'Pass not found'});
      }

      // Soft delete the pass
      await Pass.update(
        {isDeleted: true},
        {
          where: {id: parseInt(id)},
          transaction,
        },
      );

      // Update level clear count
      await Level.decrement('clears', {
        where: {id: pass.levelId},
        transaction,
      });

      // If this was the last clear, update isCleared status
      const remainingClears = await Pass.count({
        where: {
          levelId: pass.levelId,
          isDeleted: false,
        },
        transaction,
      });

      if (remainingClears === 0) {
        await Level.update(
          {isCleared: false},
          {
            where: {id: pass.levelId},
            transaction,
          },
        );
      }

      await transaction.commit();

      const io = getIO();
      io.emit('passesUpdated');

      return res.json({
        message: 'Pass soft deleted successfully',
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error soft deleting pass:', error);
      return res.status(500).json({error: 'Failed to soft delete pass'});
    }
  },
);

// Add restore endpoint
router.patch(
  '/:id/restore',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const {id} = req.params;

      const pass = await Pass.findOne({
        where: {id: parseInt(id)},
        include: [
          {
            model: Level,
            as: 'level',
          },
        ],
        transaction,
      });

      if (!pass) {
        await transaction.rollback();
        return res.status(404).json({error: 'Pass not found'});
      }

      // Restore the pass
      await Pass.update(
        {isDeleted: false},
        {
          where: {id: parseInt(id)},
          transaction,
        },
      );

      // Update level clear count and status
      await Promise.all([
        Level.increment('clears', {
          where: {id: pass.levelId},
          transaction,
        }),
        Level.update(
          {isCleared: true},
          {
            where: {id: pass.levelId},
            transaction,
          },
        ),
      ]);

      await transaction.commit();

      const io = getIO();
      io.emit('passesUpdated');

      return res.json({
        message: 'Pass restored successfully',
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error restoring pass:', error);
      return res.status(500).json({error: 'Failed to restore pass'});
    }
  },
);

// Add new route for getting pass by ID as a list
router.get('/byId/:id', async (req: Request, res: Response) => {
  try {
    const pass = await Pass.findOne({
      where: {
        id: parseInt(req.params.id),
        '$player.isBanned$': false,
      },
      include: [
        {
          model: Player,
          as: 'player',
          attributes: ['name', 'country', 'isBanned'],
        },
        {
          model: Level,
          as: 'level',
          attributes: ['song', 'artist', 'pguDiff', 'baseScore'],
        },
        {
          model: Judgement,
          as: 'judgements',
        },
      ],
    });

    if (!pass) {
      return res.json({count: 0, results: []});
    }

    return res.json({count: 1, results: [pass]});
  } catch (error) {
    console.error('Error fetching pass by ID:', error);
    return res.status(500).json({error: 'Failed to fetch pass'});
  }
});

export default router;
