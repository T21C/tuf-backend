import { Request, Response, Router } from 'express';
import { Op, OrderItem } from 'sequelize';
import Level from '../../models/Level';
import Pass from '../../models/Pass';
import Rating from '../../models/Rating';
import Player from '../../models/Player';
import Judgement from '../../models/Judgement';
import { calculateBaseScore, calculatePguDiffNum } from '../../utils/ratingUtils';
import { Auth } from '../../middleware/auth';
import { getIO } from '../../utils/socket';
import sequelize from '../../config/db';

const router: Router = Router();

// Helper function to build where clause
const buildWhereClause = (query: any) => {
  const where: any = {};
  const conditions: any[] = [];
  
  // Handle deleted filter
  if (query.deletedFilter === 'hide') {
    conditions.push({ isDeleted: false });
  } else if (query.deletedFilter === 'only') {
    conditions.push({ isDeleted: true });
  }
  // 'show' case doesn't need any condition as it shows both

  // Text search conditions
  if (query.query) {
    const searchTerm = `%${query.query}%`;
    conditions.push({
      [Op.or]: [
        { song: { [Op.like]: searchTerm } },
        { artist: { [Op.like]: searchTerm } },
        { charter: { [Op.like]: searchTerm } }
      ]
    });
  }

  // Specific field searches
  if (query.artistQuery) conditions.push({ artist: { [Op.like]: `%${query.artistQuery}%` } });
  if (query.songQuery) conditions.push({ song: { [Op.like]: `%${query.songQuery}%` } });
  if (query.charterQuery) conditions.push({ charter: { [Op.like]: `%${query.charterQuery}%` } });

  // Difficulty filters
  const diffConditions: any[] = [];
  if (query.hideCensored === 'true') diffConditions.push({ [Op.ne]: -2 });
  if (query.hideEpic === 'true') diffConditions.push({ [Op.ne]: 0.9 });
  if (query.hideUnranked === 'true') diffConditions.push({ [Op.ne]: 0 });
  
  if (diffConditions.length > 0) {
    conditions.push({ diff: { [Op.and]: diffConditions } });
  }

  // PGU difficulty range
  const pguConditions: any[] = [];
  if (query.minDiff) pguConditions.push({ [Op.gte]: Number(query.minDiff) });
  if (query.maxDiff) pguConditions.push({ [Op.lte]: Number(query.maxDiff) });
  
  if (pguConditions.length > 0) {
    conditions.push({ pguDiffNum: { [Op.and]: pguConditions } });
  }

  // Combine all conditions with AND
  if (conditions.length > 0) {
    where[Op.and] = conditions;
  }

  return where;
};

// Get sort options
const getSortOptions = (sort?: string) => {
  switch (sort) {
    case 'RECENT_DESC': return [['id', 'DESC']];
    case 'RECENT_ASC': return [['id', 'ASC']];
    case 'DIFF_DESC': return [['pguDiffNum', 'DESC']];
    case 'DIFF_ASC': return [['pguDiffNum', 'ASC']];
    default: return [['id', 'DESC']];
  }
};

// Get all charts with filtering and pagination
router.get('/', async (req: Request, res: Response) => {
  try {
    const routeStart = performance.now();

    if (req.query.sort === 'RANDOM') {
      const where = buildWhereClause(req.query);
      const count = await Level.count({ where });
      
      // Get all IDs that match the criteria
      const allIds = await Level.findAll({
        where,
        attributes: ['id'],
        raw: true
      });

      // Shuffle IDs
      const shuffledIds = allIds
        .map(item => item.id)
        .sort(() => Math.random() - 0.5);

      // Get paginated results
      const offset = req.query.offset ? Number(req.query.offset) : 0;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      
      const results = await Level.findAll({
        where: {
          id: { [Op.in]: shuffledIds.slice(offset, limit ? offset + limit : undefined) }
        },
        include: [{
          model: Pass,
          as: 'levelPasses',
          include: [{
            model: Player,
            as: 'player'
          }, {
            model: Judgement,
            as: 'judgements'
          }]
        }]
      });

      return res.json({ count, results });
    }

    // Normal sorting
    const results = await Level.findAll({
      where: buildWhereClause(req.query),
      order: getSortOptions(req.query.sort as string) as OrderItem[],
      include: [{
        model: Pass,
        as: 'levelPasses',
        include: [{
          model: Player,
          as: 'player'
        }, {
          model: Judgement,
          as: 'judgements'
        }]
      }],
      offset: req.query.offset ? Number(req.query.offset) : 0,
      limit: req.query.limit ? Number(req.query.limit) : undefined
    });

    const count = await Level.count({ where: buildWhereClause(req.query) });

    const totalTime = performance.now() - routeStart;
    console.log(`[PERF] Total route time: ${totalTime.toFixed(2)}ms`);

    return res.json({ count, results });
  } catch (error) {
    console.error('Error fetching charts:', error);
    return res.status(500).json({ error: 'Failed to fetch charts' });
  }
});

// Get a single chart by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const chart = await Level.findOne({
      where: { id: parseInt(req.params.id) },
      include: [{
        model: Pass,
        as: 'levelPasses',
        include: [{
          model: Player,
          as: 'player'
        }, {
          model: Judgement,
          as: 'judgements'
        }]
      }]
    });

    if (!chart) {
      return res.status(404).json({ error: 'Chart not found' });
    }

    return res.json(chart);
  } catch (error) {
    console.error('Error fetching chart:', error);
    return res.status(500).json({ error: 'Failed to fetch chart' });
  }
});

// Update a chart
router.put('/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { id } = req.params;
    const chart = await Level.findOne({ 
      where: { id: parseInt(id) },
      transaction
    });

    if (!chart) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Chart not found' });
    }

    // Calculate new pguDiffNum if pguDiff is being updated
    let pguDiffNum = chart.pguDiffNum;
    if (req.body.pguDiff && req.body.pguDiff !== chart.pguDiff) {
      pguDiffNum = calculatePguDiffNum(req.body.pguDiff);
    }

    // Calculate new baseScore if diff is being updated
    let baseScore = chart.baseScore;
    if (req.body.diff && req.body.diff !== chart.diff) {
      baseScore = calculateBaseScore(req.body.diff);
    }

    // Update chart
    const [affectedCount, [updatedChart]] = await Level.update({
      song: req.body.song,
      artist: req.body.artist,
      creator: req.body.creator,
      charter: req.body.charter,
      vfxer: req.body.vfxer,
      team: req.body.team,
      diff: req.body.diff,
      legacyDiff: req.body.legacyDiff,
      pguDiff: req.body.pguDiff,
      pguDiffNum,
      newDiff: req.body.newDiff,
      baseScore,
      baseScoreDiff: req.body.baseScoreDiff,
      isCleared: req.body.isCleared,
      clears: req.body.clears,
      vidLink: req.body.vidLink,
      dlLink: req.body.dlLink,
      workshopLink: req.body.workshopLink,
      publicComments: req.body.publicComments,
      toRate: req.body.toRate,
      rerateReason: req.body.rerateReason,
      rerateNum: req.body.rerateNum
    }, {
      where: { id: parseInt(id) },
      returning: true,
      transaction
    });

    await transaction.commit();

    const io = getIO();
    io.emit('chartsUpdated');

    return res.json({
      message: 'Chart updated successfully',
      chart: updatedChart
    });

  } catch (error) {
    await transaction.rollback();
    console.error('Error updating chart:', error);
    return res.status(500).json({ error: 'Failed to update chart' });
  }
});

// Soft delete a chart
router.patch('/:id/soft-delete', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { id } = req.params;
    
    const chart = await Level.findOne({ 
      where: { id: parseInt(id) },
      transaction
    });
    
    if (!chart) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Chart not found' });
    }

    // Soft delete the chart
    await Level.update(
      { isDeleted: true },
      { 
        where: { id: parseInt(id) },
        transaction
      }
    );

    await transaction.commit();

    const io = getIO();
    io.emit('chartsUpdated');

    return res.json({ 
      message: 'Chart soft deleted successfully'
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error soft deleting chart:', error);
    return res.status(500).json({ error: 'Failed to soft delete chart' });
  }
});

// Restore a soft-deleted chart
router.patch('/:id/restore', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { id } = req.params;
    
    const chart = await Level.findOne({ 
      where: { id: parseInt(id) },
      transaction
    });
    
    if (!chart) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Chart not found' });
    }

    // Restore the chart
    await Level.update(
      { isDeleted: false },
      { 
        where: { id: parseInt(id) },
        transaction
      }
    );

    await transaction.commit();

    const io = getIO();
    io.emit('chartsUpdated');

    return res.json({ 
      message: 'Chart restored successfully'
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error restoring chart:', error);
    return res.status(500).json({ error: 'Failed to restore chart' });
  }
});

export default router;
