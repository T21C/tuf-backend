import {Router, type Request, type Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import {standardErrorResponses404500} from '@/server/schemas/common.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {KeyboardSetupError} from '@/misc/utils/keyboards/types.js';
import {
  createRig,
  deleteBoardPeriod,
  deleteLane,
  deleteLanePeriod,
  deleteRig,
  getPlayerKeyboardSetups,
  importRigSnapshot,
  listLanePeriodsForPlayer,
  saveRigRevision,
  setPassBindOverride,
  updateRig,
  upsertBoardPeriod,
  upsertLanePeriod,
} from '@/server/services/keyboards/keyboardSetupService.js';

const router: Router = Router();

function playerIdOrThrow(req: Request): number {
  const playerId = req.user?.playerId;
  if (!req.user?.id) {
    throw new KeyboardSetupError(401, 'Unauthorized');
  }
  if (!playerId) {
    throw new KeyboardSetupError(400, 'No player profile linked to this account');
  }
  return playerId;
}

function sendError(res: Response, error: unknown, label: string) {
  if (error instanceof KeyboardSetupError) {
    return res.status(error.status).json({error: error.message});
  }
  logger.error(label, error);
  return res.status(500).json({
    error: 'Failed to update keyboard setup',
    details: error instanceof Error ? error.message : String(error),
  });
}

router.get(
  '/',
  Auth.user(),
  ApiDoc({
    operationId: 'v3GetMyKeyboardSetups',
    summary: 'Get my keyboard setup history',
    tags: ['Database', 'Players', 'Keyboards', 'v3'],
    security: ['bearerAuth'],
    responses: {200: {description: 'Keyboard setups'}, ...standardErrorResponses404500},
  }),
  async (req: Request, res: Response) => {
    try {
      const playerId = playerIdOrThrow(req);
      return res.json(await getPlayerKeyboardSetups(playerId, {visibleOnly: false}));
    } catch (error) {
      return sendError(res, error, '[v3 GET /players/me/keyboard-setups]');
    }
  },
);

router.get(
  '/lane-periods',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const playerId = playerIdOrThrow(req);
      return res.json({items: await listLanePeriodsForPlayer(playerId)});
    } catch (error) {
      return sendError(res, error, '[v3 GET /players/me/keyboard-setups/lane-periods]');
    }
  },
);

router.post(
  '/rigs',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const playerId = playerIdOrThrow(req);
      return res.status(201).json(await createRig(playerId, req.body ?? {}));
    } catch (error) {
      return sendError(res, error, '[v3 POST /players/me/keyboard-setups/rigs]');
    }
  },
);

router.post(
  '/rigs/import',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const playerId = playerIdOrThrow(req);
      const mode = req.body?.mode;
      const created = mode === 'duplicate';
      const rig = await importRigSnapshot(playerId, req.body ?? {});
      return res.status(created ? 201 : 200).json(rig);
    } catch (error) {
      return sendError(res, error, '[v3 POST /players/me/keyboard-setups/rigs/import]');
    }
  },
);

router.patch(
  '/rigs/:rigId',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const playerId = playerIdOrThrow(req);
      const rigId = Number(req.params.rigId);
      return res.json(await updateRig(playerId, rigId, req.body ?? {}));
    } catch (error) {
      return sendError(res, error, '[v3 PATCH /players/me/keyboard-setups/rigs/:id]');
    }
  },
);

router.delete(
  '/rigs/:rigId',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const playerId = playerIdOrThrow(req);
      return res.json(await deleteRig(playerId, Number(req.params.rigId)));
    } catch (error) {
      return sendError(res, error, '[v3 DELETE /players/me/keyboard-setups/rigs/:id]');
    }
  },
);

router.post(
  '/rigs/:rigId/revisions',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const playerId = playerIdOrThrow(req);
      return res.status(201).json(
        await saveRigRevision(playerId, Number(req.params.rigId), req.body ?? {}),
      );
    } catch (error) {
      return sendError(res, error, '[v3 POST /players/me/keyboard-setups/rigs/:id/revisions]');
    }
  },
);

router.post(
  '/rigs/:rigId/board-periods',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const playerId = playerIdOrThrow(req);
      return res.status(201).json(
        await upsertBoardPeriod(playerId, Number(req.params.rigId), req.body ?? {}),
      );
    } catch (error) {
      return sendError(res, error, '[v3 POST board-periods]');
    }
  },
);

router.patch(
  '/board-periods/:periodId',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const playerId = playerIdOrThrow(req);
      const periodId = Number(req.params.periodId);
      const body = req.body ?? {};
      const rigId = Number(body.rigId);
      if (!Number.isInteger(rigId) || rigId <= 0) {
        throw new KeyboardSetupError(400, 'rigId is required');
      }
      return res.json(await upsertBoardPeriod(playerId, rigId, body, periodId));
    } catch (error) {
      return sendError(res, error, '[v3 PATCH board-periods]');
    }
  },
);

router.delete(
  '/board-periods/:periodId',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const playerId = playerIdOrThrow(req);
      return res.json(await deleteBoardPeriod(playerId, Number(req.params.periodId)));
    } catch (error) {
      return sendError(res, error, '[v3 DELETE board-periods]');
    }
  },
);

router.post(
  '/lanes/:laneId/periods',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const playerId = playerIdOrThrow(req);
      return res.status(201).json(
        await upsertLanePeriod(playerId, Number(req.params.laneId), req.body ?? {}),
      );
    } catch (error) {
      return sendError(res, error, '[v3 POST lane periods]');
    }
  },
);

router.patch(
  '/lane-periods/:periodId',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const playerId = playerIdOrThrow(req);
      const periodId = Number(req.params.periodId);
      const body = req.body ?? {};
      const laneId = Number(body.laneId);
      if (!Number.isInteger(laneId) || laneId <= 0) {
        throw new KeyboardSetupError(400, 'laneId is required');
      }
      return res.json(await upsertLanePeriod(playerId, laneId, body, periodId));
    } catch (error) {
      return sendError(res, error, '[v3 PATCH lane-periods]');
    }
  },
);

router.delete(
  '/lane-periods/:periodId',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const playerId = playerIdOrThrow(req);
      return res.json(await deleteLanePeriod(playerId, Number(req.params.periodId)));
    } catch (error) {
      return sendError(res, error, '[v3 DELETE lane-periods]');
    }
  },
);

router.delete(
  '/lanes/:laneId',
  Auth.user(),
  async (req: Request, res: Response) => {
    try {
      const playerId = playerIdOrThrow(req);
      return res.json(await deleteLane(playerId, Number(req.params.laneId)));
    } catch (error) {
      return sendError(res, error, '[v3 DELETE lanes]');
    }
  },
);

export default router;

export async function patchMyPassKeyboardSetup(req: Request, res: Response) {
  try {
    if (!req.user?.id) {
      throw new KeyboardSetupError(401, 'Unauthorized');
    }
    const passId = Number(req.params.passId);
    const raw = req.body?.lanePeriodId;
    const lanePeriodId = raw == null || raw === '' ? null : Number(raw);
    if (lanePeriodId != null && (!Number.isInteger(lanePeriodId) || lanePeriodId <= 0)) {
      throw new KeyboardSetupError(400, 'lanePeriodId is invalid');
    }
    const isSuperAdmin = Boolean(req.user.isSuperAdmin);
    if (!req.user.playerId && !isSuperAdmin) {
      throw new KeyboardSetupError(400, 'No player profile linked to this account');
    }
    return res.json(
      await setPassBindOverride(
        {playerId: req.user.playerId ?? null, isSuperAdmin},
        passId,
        lanePeriodId,
      ),
    );
  } catch (error) {
    return sendError(res, error, '[v3 PATCH /players/me/passes/:passId/keyboard-setup]');
  }
}
