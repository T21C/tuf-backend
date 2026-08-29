import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {respondMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import Mod from '@/models/misc/Mod.js';
import {parseModCreate, parseModPatch} from '@/server/services/mods/modFields.js';
import {serializeMod} from '@/server/services/mods/serializeMod.js';
import {invalidatePublicModsCache} from '@/server/services/mods/modCache.js';

const router: Router = Router();

function serializeAdminMod(mod: Mod) {
  return serializeMod(mod, {includeHidden: true});
}

router.get(
  '/',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminListMods',
    summary: 'List all mods including hidden',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'All mods ordered by name'}},
  }),
  async (_req: Request, res: Response) => {
    try {
      const mods = await Mod.findAll({
        order: [
          ['name', 'ASC'],
          ['id', 'ASC'],
        ],
      });
      return res.json({mods: mods.map(serializeAdminMod)});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to list mods', {
        logLabel: 'Admin list mods failed:',
      });
    }
  },
);

router.post(
  '/',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminCreateMod',
    summary: 'Create a catalog mod',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {201: {description: 'Created'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseModCreate(req.body);
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      const created = await Mod.create(parsed.value);
      await invalidatePublicModsCache();
      return res.status(201).json(serializeAdminMod(created));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to create mod', {
        logLabel: 'Create mod failed:',
      });
    }
  },
);

router.patch(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminUpdateMod',
    summary: 'Update a catalog mod',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Updated'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const parsed = parseModPatch(req.body);
      if (!parsed.ok) return res.status(400).json({error: parsed.error});
      const mod = await Mod.findByPk(req.params.id);
      if (!mod) return res.status(404).json({error: 'Mod not found'});
      await mod.update(parsed.value);
      await invalidatePublicModsCache();
      return res.json(serializeAdminMod(mod));
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to update mod', {
        logLabel: 'Update mod failed:',
      });
    }
  },
);

router.delete(
  '/:id([0-9]{1,20})',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'adminDeleteMod',
    summary: 'Delete a catalog mod',
    tags: ['Admin', 'Mods'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Deleted'}},
  }),
  async (req: Request, res: Response) => {
    try {
      const mod = await Mod.findByPk(req.params.id);
      if (!mod) return res.status(404).json({error: 'Mod not found'});
      await mod.destroy();
      await invalidatePublicModsCache();
      return res.json({success: true});
    } catch (error) {
      return respondMysqlClientError(res, error, 'Failed to delete mod', {
        logLabel: 'Delete mod failed:',
      });
    }
  },
);

export default router;
