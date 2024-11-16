import { Request } from 'express';
import { createCachedRoute } from '../createCachedRoute';
import { escapeRegExp } from '../../../misc/Utility';
import Level from '../../../models/Level';

const chartsRoute = createCachedRoute({
  model: Level,
  cachePrefix: 'charts',
  cacheTTL: 200 * 1000, // optional, defaults to 200 seconds
  
  buildQuery: (req: Request) => {
    const query = req.query;
    const conditions: any[] = [];

    if (query.query) {
      const queryRegex = new RegExp(escapeRegExp(query.query as string), 'i');
      conditions.push({
        $or: [
          { song: queryRegex },
          { artist: queryRegex },
          { charter: queryRegex },
        ],
      });
    }

    if (query.artistQuery) {
      conditions.push({ artist: new RegExp(escapeRegExp(query.artistQuery as string), 'i') });
    }

    if (query.songQuery) {
      conditions.push({ song: new RegExp(escapeRegExp(query.songQuery as string), 'i') });
    }

    if (query.charterQuery) {
      conditions.push({ charter: new RegExp(escapeRegExp(query.charterQuery as string), 'i') });
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

export default chartsRoute;
