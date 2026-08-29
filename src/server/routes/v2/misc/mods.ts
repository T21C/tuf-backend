import {Router, Request, Response} from 'express';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {Cache} from '@/server/middleware/cache.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import Mod from '@/models/misc/Mod.js';
import {serializeMod} from '@/server/services/mods/serializeMod.js';
import {PUBLIC_MODS_CACHE_TAG} from '@/server/services/mods/modCache.js';

const router: Router = Router();

router.get(
  '/',
  Cache({
    ttl: 300,
    prefix: 'mods:public',
    tags: [PUBLIC_MODS_CACHE_TAG],
  }),
  ApiDoc({
    operationId: 'listMods',
    summary: 'List public mods for the catalog page',
    tags: ['Misc'],
    responses: {200: {description: 'Public mods ordered by name'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      const mods = await Mod.findAll({
        where: {hidden: false},
        order: [
          ['name', 'ASC'],
          ['id', 'ASC'],
        ],
      });
      return res.json({mods: mods.map((mod) => serializeMod(mod))});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list mods', {
        logLabel: 'List mods failed:',
      });
    }
  },
);

export default router;
