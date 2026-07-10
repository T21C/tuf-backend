import { Op, type Transaction } from 'sequelize';
import ProfileCustomizationPiece, {
  type ProfileCustomizationPayload,
  type ProfileCustomizationUnit,
} from '@/models/profile/ProfileCustomizationPiece.js';
import User from '@/models/auth/User.js';
import cdnService from '@/server/services/core/CdnService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  assemblePresentationFromPieces,
  buildPresentationSyncMap,
  extractAssetIdsFromPayload,
  isPieceLinked,
} from '@/server/services/profileCustomization/payloadUtils.js';
import {
  collectAssetIdsForUser,
  diffReleasedAssetIds,
  releaseUnreferencedAssets,
} from '@/server/services/profileCustomization/assetRelease.js';
import type {
  AssembledPresentation,
  PresentationSyncMap,
} from '@/server/services/profileCustomization/types.js';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('auth');

export type ProfileEntityKind = 'player' | 'creator';

export class ProfileCustomizationError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function getPiecesForUser(userId: string): Promise<ProfileCustomizationPiece[]> {
  return ProfileCustomizationPiece.findAll({ where: { userId } });
}

export async function getPiecesForPlayer(playerId: number): Promise<ProfileCustomizationPiece[]> {
  return ProfileCustomizationPiece.findAll({ where: { playerId } });
}

export async function getPiecesForCreator(creatorId: number): Promise<ProfileCustomizationPiece[]> {
  return ProfileCustomizationPiece.findAll({ where: { creatorId } });
}

export async function getPieceForEntity(
  entityKind: ProfileEntityKind,
  entityId: number,
  unit: ProfileCustomizationUnit,
): Promise<ProfileCustomizationPiece | null> {
  const where =
    entityKind === 'player' ? { playerId: entityId, unit } : { creatorId: entityId, unit };
  return ProfileCustomizationPiece.findOne({ where });
}

export async function assemblePresentationForPlayer(
  playerId: number,
): Promise<AssembledPresentation> {
  const pieces = await getPiecesForPlayer(playerId);
  return assemblePresentationFromPieces(pieces.map((p) => ({ unit: p.unit, payload: p.payload })));
}

export async function assemblePresentationForCreator(
  creatorId: number,
): Promise<AssembledPresentation> {
  const pieces = await getPiecesForCreator(creatorId);
  return assemblePresentationFromPieces(pieces.map((p) => ({ unit: p.unit, payload: p.payload })));
}

export async function getPresentationSyncForUser(userId: string): Promise<PresentationSyncMap> {
  const pieces = await getPiecesForUser(userId);
  return buildPresentationSyncMap(pieces);
}

export async function resolveUserContextForEntity(
  entityKind: ProfileEntityKind,
  entityId: number,
): Promise<{ userId: string; playerId: number | null; creatorId: number | null }> {
  if (entityKind === 'player') {
    const user = await User.findOne({ where: { playerId: entityId }, attributes: ['id', 'playerId', 'creatorId'] });
    if (!user) {
      throw new ProfileCustomizationError(404, 'User not found for player');
    }
    return { userId: user.id, playerId: user.playerId ?? entityId, creatorId: user.creatorId ?? null };
  }
  const user = await User.findOne({ where: { creatorId: entityId }, attributes: ['id', 'playerId', 'creatorId'] });
  if (user) {
    return { userId: user.id, playerId: user.playerId ?? null, creatorId: user.creatorId ?? entityId };
  }
  throw new ProfileCustomizationError(404, 'User not found for creator');
}

export async function upsertPieceForEntity(
  entityKind: ProfileEntityKind,
  entityId: number,
  unit: ProfileCustomizationUnit,
  payload: ProfileCustomizationPayload,
  transaction?: Transaction,
): Promise<ProfileCustomizationPiece> {
  const ctx = await resolveUserContextForEntity(entityKind, entityId);
  const existing = await getPieceForEntity(entityKind, entityId, unit);
  const beforePayload = existing?.payload ?? null;

  if (existing) {
    await existing.update({ payload }, { transaction });
    const released = diffReleasedAssetIds(beforePayload, payload, unit);
    if (released.length) {
      await releaseUnreferencedAssets(ctx.userId, released);
    }
    return existing;
  }

  const playerId = entityKind === 'player' ? entityId : null;
  const creatorId = entityKind === 'creator' ? entityId : null;

  const created = await ProfileCustomizationPiece.create(
    {
      userId: ctx.userId,
      playerId,
      creatorId,
      unit,
      payload,
    },
    { transaction },
  );

  return created;
}

export async function patchPiecePayloadForEntity(
  entityKind: ProfileEntityKind,
  entityId: number,
  unit: ProfileCustomizationUnit,
  patch: (current: ProfileCustomizationPayload) => ProfileCustomizationPayload,
): Promise<ProfileCustomizationPiece> {
  const ctx = await resolveUserContextForEntity(entityKind, entityId);
  const existing = await getPieceForEntity(entityKind, entityId, unit);
  const beforePayload = existing?.payload ?? {};
  const nextPayload = patch({ ...beforePayload });

  if (existing) {
    const beforeCopy = { ...existing.payload };
    await existing.update({ payload: nextPayload });
    const released = diffReleasedAssetIds(beforeCopy, nextPayload, unit);
    if (released.length) {
      await releaseUnreferencedAssets(ctx.userId, released);
    }
    return existing;
  }

  const playerId = entityKind === 'player' ? entityId : null;
  const creatorId = entityKind === 'creator' ? entityId : null;
  return ProfileCustomizationPiece.create({
    userId: ctx.userId,
    playerId,
    creatorId,
    unit,
    payload: nextPayload,
  });
}

export async function linkUnit(params: {
  userId: string;
  playerId: number;
  creatorId: number;
  unit: ProfileCustomizationUnit;
  source: ProfileEntityKind;
}): Promise<ProfileCustomizationPiece> {
  const { userId, playerId, creatorId, unit, source } = params;

  return sequelize.transaction(async (transaction) => {
    const playerPiece = await ProfileCustomizationPiece.findOne({
      where: { playerId, unit },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const creatorPiece = await ProfileCustomizationPiece.findOne({
      where: { creatorId, unit },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    const winner = source === 'player' ? playerPiece : creatorPiece;
    const loser = source === 'player' ? creatorPiece : playerPiece;

    const payload: ProfileCustomizationPayload =
      winner?.payload ??
      loser?.payload ??
      (unit === 'stellar_icon' ? { tufStellarIconVariant: '1' } : {});

    const loserAssetIds = loser
      ? extractAssetIdsFromPayload(loser.payload, unit).filter(
          (id) => !extractAssetIdsFromPayload(payload, unit).includes(id),
        )
      : [];

    if (playerPiece) await playerPiece.destroy({ transaction });
    if (creatorPiece && creatorPiece.id !== playerPiece?.id) {
      await creatorPiece.destroy({ transaction });
    }

    const linked = await ProfileCustomizationPiece.create(
      {
        userId,
        playerId,
        creatorId,
        unit,
        payload,
      },
      { transaction },
    );

    if (loserAssetIds.length) {
      await releaseUnreferencedAssets(userId, loserAssetIds);
    }

    return linked;
  });
}

export async function unlinkUnit(params: {
  userId: string;
  playerId: number;
  creatorId: number;
  unit: ProfileCustomizationUnit;
}): Promise<{ playerPiece: ProfileCustomizationPiece; creatorPiece: ProfileCustomizationPiece }> {
  const { userId, playerId, creatorId, unit } = params;

  return sequelize.transaction(async (transaction) => {
    const linked = await ProfileCustomizationPiece.findOne({
      where: { playerId, creatorId, unit },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!linked || !isPieceLinked(linked)) {
      throw new ProfileCustomizationError(400, 'Unit is not linked');
    }

    const payload = { ...linked.payload };
    await linked.destroy({ transaction });

    const playerPiece = await ProfileCustomizationPiece.create(
      { userId, playerId, creatorId: null, unit, payload },
      { transaction },
    );
    const creatorPiece = await ProfileCustomizationPiece.create(
      { userId, playerId: null, creatorId, unit, payload: { ...payload } },
      { transaction },
    );

    return { playerPiece, creatorPiece };
  });
}

export async function handleCreatorPurgePieces(creatorId: number, userId: string | null): Promise<void> {
  const pieces = await ProfileCustomizationPiece.findAll({ where: { creatorId } });
  const assetCandidates: string[] = [];

  for (const piece of pieces) {
    assetCandidates.push(...extractAssetIdsFromPayload(piece.payload, piece.unit));
    if (piece.playerId != null) {
      await piece.update({ creatorId: null });
    } else {
      await piece.destroy();
    }
  }

  if (userId && assetCandidates.length) {
    await releaseUnreferencedAssets(userId, assetCandidates);
  }
}

export async function handleAccountDeletePieces(userId: string): Promise<void> {
  const assetIds = await collectAssetIdsForUser(userId);
  await ProfileCustomizationPiece.destroy({ where: { userId } });
  for (const assetId of assetIds) {
    try {
      if (await cdnService.checkFileExists(assetId)) {
        await cdnService.deleteFile(assetId);
      }
    } catch (err) {
      logger.error('[ProfileCustomization] Account delete CDN cleanup failed', { userId, assetId, err });
    }
  }
}

export function getReindexIdsFromPiece(piece: ProfileCustomizationPiece): {
  playerIds: number[];
  creatorIds: number[];
} {
  const playerIds = piece.playerId != null ? [piece.playerId] : [];
  const creatorIds = piece.creatorId != null ? [piece.creatorId] : [];
  return { playerIds, creatorIds };
}

export async function loadPresentationMapForPlayerIds(
  playerIds: number[],
): Promise<Map<number, AssembledPresentation>> {
  const ids = [...new Set(playerIds.filter((id) => Number.isFinite(id) && id > 0))];
  const out = new Map<number, AssembledPresentation>();
  if (ids.length === 0) return out;

  const pieces = await ProfileCustomizationPiece.findAll({
    where: { playerId: { [Op.in]: ids } },
  });
  const byPlayer = new Map<number, Array<{ unit: ProfileCustomizationUnit; payload: ProfileCustomizationPayload }>>();
  for (const piece of pieces) {
    if (piece.playerId == null) continue;
    const list = byPlayer.get(piece.playerId) ?? [];
    list.push({ unit: piece.unit, payload: piece.payload });
    byPlayer.set(piece.playerId, list);
  }
  for (const id of ids) {
    out.set(id, assemblePresentationFromPieces(byPlayer.get(id) ?? []));
  }
  return out;
}

export async function loadPresentationMapForCreatorIds(
  creatorIds: number[],
): Promise<Map<number, AssembledPresentation>> {
  const ids = [...new Set(creatorIds.filter((id) => Number.isFinite(id) && id > 0))];
  const out = new Map<number, AssembledPresentation>();
  if (ids.length === 0) return out;

  const pieces = await ProfileCustomizationPiece.findAll({
    where: { creatorId: { [Op.in]: ids } },
  });
  const byCreator = new Map<number, Array<{ unit: ProfileCustomizationUnit; payload: ProfileCustomizationPayload }>>();
  for (const piece of pieces) {
    if (piece.creatorId == null) continue;
    const list = byCreator.get(piece.creatorId) ?? [];
    list.push({ unit: piece.unit, payload: piece.payload });
    byCreator.set(piece.creatorId, list);
  }
  for (const id of ids) {
    out.set(id, assemblePresentationFromPieces(byCreator.get(id) ?? []));
  }
  return out;
}
