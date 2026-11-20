import { Router, type Request, type Response } from 'express';
import { Auth } from '@/server/middleware/auth.js';
import Creator from '@/models/credits/Creator.js';
import { readOwnerBadges, saveOwnerEquips } from '@/server/services/badges/index.js';

const router = Router();

router.get('/players/:playerId', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  const playerId = Number(req.params.playerId);
  if (!Number.isInteger(playerId) || playerId <= 0) {
    res.status(400).json({ error: 'Invalid player' });
    return;
  }
  const canEquip = Number(req.user?.playerId) === playerId;
  res.json(await readOwnerBadges('player', playerId, canEquip));
});

router.put('/players/:playerId/equip', Auth.user(), async (req: Request, res: Response) => {
  const playerId = Number(req.params.playerId);
  if (Number(req.user?.playerId) !== playerId) {
    res.status(403).json({ error: 'You can only equip your own badges' });
    return;
  }
  const badgeIds = Array.isArray(req.body?.badgeIds) ? req.body.badgeIds.map(Number) : [];
  try {
    await saveOwnerEquips('player', playerId, badgeIds);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not equip badges' });
    return;
  }
  res.json(await readOwnerBadges('player', playerId, true));
});

router.get('/creators/:creatorId', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  const creatorId = Number(req.params.creatorId);
  if (!Number.isInteger(creatorId) || creatorId <= 0) {
    res.status(400).json({ error: 'Invalid creator' });
    return;
  }
  const creator = req.user?.id
    ? await Creator.findOne({ where: { id: creatorId, userId: req.user.id }, attributes: ['id'] })
    : null;
  res.json(await readOwnerBadges('creator', creatorId, Boolean(creator)));
});

router.put('/creators/:creatorId/equip', Auth.user(), async (req: Request, res: Response) => {
  const creatorId = Number(req.params.creatorId);
  const creator = await Creator.findOne({
    where: { id: creatorId, userId: req.user?.id ?? '' },
    attributes: ['id'],
  });
  if (!creator) {
    res.status(403).json({ error: 'You can only equip your own badges' });
    return;
  }
  const badgeIds = Array.isArray(req.body?.badgeIds) ? req.body.badgeIds.map(Number) : [];
  try {
    await saveOwnerEquips('creator', creatorId, badgeIds);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not equip badges' });
    return;
  }
  res.json(await readOwnerBadges('creator', creatorId, true));
});

export default router;
