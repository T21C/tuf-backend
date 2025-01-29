import {Request, Response, NextFunction} from 'express';
import {Op} from 'sequelize';

const PLACEHOLDER =
  '' +
  process.env.PLACEHOLDER_PREFIX +
  process.env.PLACEHOLDER_BODY +
  process.env.PLACEHOLDER_POSTFIX;

interface DataItem {
  [key: string]: any;
}

export const excludePlaceholder = {
  fromQuery: () => {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!req.query.includeAll) {
        if (!req.query.where) {
          req.query.where = {};
        }
        const where =
          typeof req.query.where === 'string'
            ? JSON.parse(req.query.where)
            : req.query.where;
        where[Op.and] = where[Op.and] || [];
        where[Op.and].push({
          [Op.and]: [
            {song: {[Op.ne]: PLACEHOLDER}},
            {artist: {[Op.ne]: PLACEHOLDER}},
            {creator: {[Op.ne]: PLACEHOLDER}},
            {charter: {[Op.ne]: PLACEHOLDER}},
          ],
        });
        req.query.where = where;
      }
      next();
    };
  },

  fromResponse: () => {
    return (req: Request, res: Response, next: NextFunction) => {
      const originalJson = res.json;

      const hasPlaceholder = (
        item: DataItem,
        depth = 0,
        seen = new WeakSet(),
      ): boolean => {
        // Prevent infinite recursion
        if (depth > 10) return false;
        if (!item || typeof item !== 'object') return false;
        if (seen.has(item)) return false;

        seen.add(item);

        // Check direct string properties first
        const directValues = Object.values(item).filter(
          value => typeof value === 'string',
        );
        if (directValues.some(value => value === PLACEHOLDER)) return true;

        // Then check nested objects and arrays
        return Object.values(item).some(value => {
          if (Array.isArray(value)) {
            return value.some(v =>
              typeof v === 'object' && v !== null
                ? hasPlaceholder(v, depth + 1, seen)
                : v === PLACEHOLDER,
            );
          }
          if (typeof value === 'object' && value !== null) {
            return hasPlaceholder(value, depth + 1, seen);
          }
          return false;
        });
      };

      res.json = function (data: any) {
        if (!req.query.includeAll && data) {
          if (Array.isArray(data)) {
            data = data.filter((item: DataItem) => !hasPlaceholder(item));
          } else if (data.results) {
            const originalCount = data.count;
            data.results = data.results.filter(
              (item: DataItem) => !hasPlaceholder(item),
            );
            data.count = originalCount;
          } else if (hasPlaceholder(data as DataItem)) {
            return res.status(404).json({error: 'Not found'});
          }
        }
        return originalJson.call(this, data);
      };
      next();
    };
  },
};
