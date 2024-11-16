import { Request } from 'express';
import { createCachedRoute } from '../createCachedRoute';
import { escapeRegExp } from '../../../misc/Utility';
import Player from '../../../models/Player';

const playersRoute = createCachedRoute({
  model: Player,
  cachePrefix: 'players',
  cacheTTL: 200 * 1000, // optional, defaults to 200 seconds
  
  buildQuery: (req: Request) => {
    const query = req.query;
    const conditions: any[] = [];

    if (query.query) {
      const queryRegex = new RegExp(escapeRegExp(query.query as string), 'i');
      conditions.push({
        $or: [
          { levelId: queryRegex },
          { player: queryRegex },
        ],
      });
    }

    if (query.query) {
      conditions.push({ player: new RegExp(escapeRegExp(query.query as string), 'i') });
    }

    return conditions.length ? { $and: conditions } : {};
  },

  getSortOptions: (req: Request) => {
    const { sort } = req.query;
    switch (sort) {
      case 'RECENT_DESC': return { createdAt: 'desc' };
      case 'RECENT_ASC': return { createdAt: 'asc' };
      default: return { createdAt: 'desc' };
    }
  }
});

export default playersRoute;
