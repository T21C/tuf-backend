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

  // Text search conditions
  if (query.query) {
    const searchTerm = `%${query.query}%`;
    where[Op.or] = [
      { song: { [Op.like]: searchTerm } },
      { artist: { [Op.like]: searchTerm } },
      { charter: { [Op.like]: searchTerm } }
    ];
  }

  // Specific field searches
  if (query.artistQuery) where.artist = { [Op.like]: `%${query.artistQuery}%` };
  if (query.songQuery) where.song = { [Op.like]: `%${query.songQuery}%` };
  if (query.charterQuery) where.charter = { [Op.like]: `%${query.charterQuery}%` };

  // Difficulty filters
  if (query.hideCensored === 'true') where.diff = { [Op.ne]: -2 };
  if (query.hideEpic === 'true') where.diff = { [Op.ne]: 0.9 };
  if (query.hideUnranked === 'true') where.diff = { [Op.ne]: 0 };
  
  if (query.minDiff) where.pguDiffNum = { [Op.gte]: Number(query.minDiff) };
  if (query.maxDiff) where.pguDiffNum = { [Op.lte]: Number(query.maxDiff) };

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
          include: [Player, Judgement]
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
        include: [Player, Judgement]
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

// ... rest of the routes (PUT, DELETE, etc.) with similar DB-first approach

export default router;
