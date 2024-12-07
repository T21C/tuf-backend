import { Request, Response, Router } from 'express';
import { Op, OrderItem } from 'sequelize';
import { escapeRegExp } from '../../misc/Utility';
import Pass from '../../models/Pass';
import Level from '../../models/Level';
import Player from '../../models/Player';
import Judgement from '../../models/Judgement';
import { Auth } from '../../middleware/auth';
import { getIO } from '../../utils/socket';
import { calcAcc } from '../../misc/CalcAcc';
import { getScoreV2 } from '../../misc/CalcScore';
import sequelize from '../../config/db';

const router: Router = Router();

// Helper function to build where clause
const buildWhereClause = (query: any) => {
  const where: any = {};

  // Handle deleted filter
  if (query.deletedFilter === 'hide') {
    where.isDeleted = false;
  } else if (query.deletedFilter === 'only') {
    where.isDeleted = true;
  }

  // Chart ID filter
  if (query.chartId) {
    where.levelId = query.chartId;
  }

  // Player name filter
  if (query.player) {
    where['$Player.name$'] = { [Op.like]: `%${escapeRegExp(query.player)}%` };
  }

  // General search
  if (query.query) {
    const searchTerm = escapeRegExp(query.query);
    where[Op.or] = [
      { '$Player.name$': { [Op.like]: `%${searchTerm}%` } },
      { '$Level.song$': { [Op.like]: `%${searchTerm}%` } },
      { '$Level.artist$': { [Op.like]: `%${searchTerm}%` } },
      { '$Level.pguDiff$': { [Op.like]: `%${searchTerm}%` } },
      { levelId: { [Op.like]: `%${searchTerm}%` } },
      { id: { [Op.like]: `%${searchTerm}%` } }
    ];
  }

  return where;
};

// Get sort options
const getSortOptions = (sort?: string): OrderItem[] => {
  switch (sort) {
    case 'SCORE_ASC': return [['scoreV2', 'ASC'] as OrderItem];
    case 'SCORE_DESC': return [['scoreV2', 'DESC'] as OrderItem];
    case 'XACC_ASC': return [['accuracy', 'ASC'] as OrderItem];
    case 'XACC_DESC': return [['accuracy', 'DESC'] as OrderItem];
    case 'DATE_ASC': return [['vidUploadTime', 'ASC'] as OrderItem];
    case 'DATE_DESC': return [['vidUploadTime', 'DESC'] as OrderItem];
    default: return [['scoreV2', 'ASC'] as OrderItem];
  }
};

router.get('/level/:chartId', async (req: Request, res: Response) => {
  try {
    const { chartId } = req.params;
    
    const passes = await Pass.findAll({
      where: {
        levelId: parseInt(chartId),
        isDeleted: false,
        '$Player.isBanned$': false
      },
      include: [
        {
          model: Player,
          attributes: ['name', 'country', 'isBanned']
        },
        {
          model: Level,
          attributes: ['song', 'artist', 'pguDiff', 'baseScore']
        },
        {
          model: Judgement
        }
      ]
    });

    return res.json(passes);
  } catch (error) {
    console.error('Error fetching passes:', error);
    return res.status(500).json({ error: 'Failed to fetch passes' });
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
          attributes: ['name', 'country', 'isBanned'],
          where: { isBanned: false }
        },
        {
          model: Level,
          attributes: ['song', 'artist', 'pguDiff', 'baseScore']
        },
        {
          model: Judgement
        }
      ],
      order: getSortOptions(req.query.sort as string)
    });

    const count = passes.length;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const results = passes.slice(offset, limit ? offset + limit : undefined);

    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total route time: ${totalTime.toFixed(2)}ms`);

    return res.json({ count, results });
  } catch (error) {
    console.error('Error fetching passes:', error);
    return res.status(500).json({ error: 'Failed to fetch passes' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const pass = await Pass.findOne({
      where: { id: parseInt(req.params.id) },
      include: [
        {
          model: Player,
          attributes: ['name', 'country', 'isBanned']
        },
        {
          model: Level,
          attributes: ['song', 'artist', 'pguDiff', 'baseScore']
        },
        {
          model: Judgement
        }
      ]
    });

    if (!pass) {
      return res.status(404).json({ error: 'Pass not found' });
    }

    return res.json(pass);
  } catch (error) {
    console.error('Error fetching pass:', error);
    return res.status(500).json({ error: 'Failed to fetch pass' });
  }
});

router.put('/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { id } = req.params;
    const originalPass = await Pass.findOne({ 
      where: { id: parseInt(id) },
      include: [Level, Judgement],
      transaction
    });

    if (!originalPass) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Pass not found' });
    }

    // Handle level change and clear count updates
    if (originalPass.levelId !== req.body.levelId) {
      await Promise.all([
        Level.decrement('clears', { 
          where: { id: originalPass.levelId },
          transaction 
        }),
        Level.increment('clears', { 
          where: { id: req.body.levelId },
          transaction 
        })
      ]);
    }

    // Calculate new accuracy and score
    const judgements = req.body.judgements;
    const accuracy = calcAcc(judgements);
    const scoreV2 = getScoreV2({
      speed: req.body.speed,
      judgements,
      isNoHoldTap: req.body.isNoHoldTap
    }, { 
      baseScore: originalPass.level?.baseScore || 0
    });

    // Update pass
    const [affectedCount, [updatedPass]] = await Pass.update({
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
      scoreV2
    }, {
      where: { id: parseInt(id) },
      returning: true,
      transaction
    });

    // Update judgements
    await Judgement.update(judgements, {
      where: { passId: parseInt(id) },
      transaction
    });

    await transaction.commit();

    const io = getIO();
    io.emit('passesUpdated');

    return res.json({
      message: 'Pass updated successfully',
      pass: updatedPass
    });

  } catch (error) {
    await transaction.rollback();
    console.error('Error updating pass:', error);
    return res.status(500).json({ error: 'Failed to update pass' });
  }
});

// Add soft delete endpoint
router.patch('/:id/soft-delete', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { id } = req.params;
    
    const pass = await Pass.findOne({ 
      where: { id: parseInt(id) },
      include: [Level],
      transaction
    });
    
    if (!pass) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Pass not found' });
    }

    // Soft delete the pass
    await Pass.update(
      { isDeleted: true },
      { 
        where: { id: parseInt(id) },
        transaction
      }
    );

    // Update level clear count
    await Level.decrement('clears', { 
      where: { id: pass.levelId },
      transaction
    });

    // If this was the last clear, update isCleared status
    const remainingClears = await Pass.count({
      where: { 
        levelId: pass.levelId,
        isDeleted: false
      },
      transaction
    });

    if (remainingClears === 0) {
      await Level.update(
        { isCleared: false },
        { 
          where: { id: pass.levelId },
          transaction
        }
      );
    }

    await transaction.commit();

    const io = getIO();
    io.emit('passesUpdated');

    return res.json({ 
      message: 'Pass soft deleted successfully'
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error soft deleting pass:', error);
    return res.status(500).json({ error: 'Failed to soft delete pass' });
  }
});

// Add restore endpoint
router.patch('/:id/restore', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { id } = req.params;
    
    const pass = await Pass.findOne({ 
      where: { id: parseInt(id) },
      include: [Level],
      transaction
    });
    
    if (!pass) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Pass not found' });
    }

    // Restore the pass
    await Pass.update(
      { isDeleted: false },
      { 
        where: { id: parseInt(id) },
        transaction
      }
    );

    // Update level clear count and status
    await Promise.all([
      Level.increment('clears', { 
        where: { id: pass.levelId },
        transaction
      }),
      Level.update(
        { isCleared: true },
        { 
          where: { id: pass.levelId },
          transaction
        }
      )
    ]);

    await transaction.commit();

    const io = getIO();
    io.emit('passesUpdated');

    return res.json({ 
      message: 'Pass restored successfully'
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error restoring pass:', error);
    return res.status(500).json({ error: 'Failed to restore pass' });
  }
});

export default router;
