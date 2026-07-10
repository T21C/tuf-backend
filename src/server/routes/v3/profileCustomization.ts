import { Router, Request, Response } from 'express';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { standardErrorResponses404500 } from '@/server/schemas/common.js';
import {
  PROFILE_CUSTOMIZATION_UNITS,
  type ProfileCustomizationUnit,
} from '@/models/profile/ProfileCustomizationPiece.js';
import {
  ProfileCustomizationError,
  getPiecesForUser,
  getPresentationSyncForUser,
  linkUnit,
  unlinkUnit,
} from '@/server/services/profileCustomization/ProfileCustomizationService.js';
import { isPieceLinked } from '@/server/services/profileCustomization/payloadUtils.js';
import { reindexProfilesForIds } from '@/server/services/profileCustomization/reindexProfiles.js';
import { logger } from '@/server/services/core/LoggerService.js';

const router: Router = Router();

function parseUnit(raw: string): ProfileCustomizationUnit | null {
  return (PROFILE_CUSTOMIZATION_UNITS as readonly string[]).includes(raw)
    ? (raw as ProfileCustomizationUnit)
    : null;
}

function requireDualProfileUser(req: Request, res: Response): { userId: string; playerId: number; creatorId: number } | null {
  const user = req.user;
  if (!user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  if (!user.playerId || !user.creatorId) {
    res.status(400).json({ error: 'Both player and creator profiles are required for sync' });
    return null;
  }
  return { userId: user.id, playerId: user.playerId, creatorId: user.creatorId };
}

router.get(
  '/',
  Auth.user(),
  ApiDoc({
    operationId: 'v3GetProfileCustomization',
    summary: 'Get profile customization pieces and sync state',
    tags: ['Profile', 'v3'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Customization pieces' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user?.id) return res.status(401).json({ error: 'Unauthorized' });

      const pieces = await getPiecesForUser(user.id);
      const presentationSync = await getPresentationSyncForUser(user.id);

      return res.json({
        pieces: pieces.map((p) => ({
          id: p.id,
          unit: p.unit,
          playerId: p.playerId,
          creatorId: p.creatorId,
          linked: isPieceLinked(p),
          payload: p.payload,
        })),
        presentationSync,
      });
    } catch (error) {
      logger.error('[v3 GET /profile-customization] failure', error);
      return res.status(500).json({ error: 'Failed to load profile customization' });
    }
  },
);

router.post(
  '/:unit/link',
  Auth.user(),
  ApiDoc({
    operationId: 'v3LinkProfileCustomizationUnit',
    summary: 'Link a customization unit between player and creator profiles',
    tags: ['Profile', 'v3'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Linked' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const ctx = requireDualProfileUser(req, res);
      if (!ctx) return;

      const unit = parseUnit(String(req.params.unit ?? ''));
      if (!unit) return res.status(400).json({ error: 'Invalid unit' });

      const body = req.body as { source?: unknown };
      const source = body.source === 'creator' ? 'creator' : body.source === 'player' ? 'player' : null;
      if (!source) {
        return res.status(400).json({ error: 'source must be "player" or "creator"' });
      }

      const linked = await linkUnit({
        userId: ctx.userId,
        playerId: ctx.playerId,
        creatorId: ctx.creatorId,
        unit,
        source,
      });

      await reindexProfilesForIds({ playerIds: [ctx.playerId], creatorIds: [ctx.creatorId] });

      return res.json({
        unit,
        linked: true,
        piece: {
          id: linked.id,
          playerId: linked.playerId,
          creatorId: linked.creatorId,
          payload: linked.payload,
        },
        presentationSync: await getPresentationSyncForUser(ctx.userId),
      });
    } catch (error) {
      if (error instanceof ProfileCustomizationError) {
        return res.status(error.status).json({ error: error.message });
      }
      logger.error('[v3 POST /profile-customization/:unit/link] failure', error);
      return res.status(500).json({ error: 'Failed to link customization unit' });
    }
  },
);

router.post(
  '/:unit/unlink',
  Auth.user(),
  ApiDoc({
    operationId: 'v3UnlinkProfileCustomizationUnit',
    summary: 'Unlink a customization unit into independent player and creator copies',
    tags: ['Profile', 'v3'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Unlinked' },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const ctx = requireDualProfileUser(req, res);
      if (!ctx) return;

      const unit = parseUnit(String(req.params.unit ?? ''));
      if (!unit) return res.status(400).json({ error: 'Invalid unit' });

      const { playerPiece, creatorPiece } = await unlinkUnit({
        userId: ctx.userId,
        playerId: ctx.playerId,
        creatorId: ctx.creatorId,
        unit,
      });

      await reindexProfilesForIds({ playerIds: [ctx.playerId], creatorIds: [ctx.creatorId] });

      return res.json({
        unit,
        linked: false,
        playerPiece: { id: playerPiece.id, payload: playerPiece.payload },
        creatorPiece: { id: creatorPiece.id, payload: creatorPiece.payload },
        presentationSync: await getPresentationSyncForUser(ctx.userId),
      });
    } catch (error) {
      if (error instanceof ProfileCustomizationError) {
        return res.status(error.status).json({ error: error.message });
      }
      logger.error('[v3 POST /profile-customization/:unit/unlink] failure', error);
      return res.status(500).json({ error: 'Failed to unlink customization unit' });
    }
  },
);

export default router;
