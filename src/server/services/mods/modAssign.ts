import {Op} from 'sequelize';
import Mod from '@/models/misc/Mod.js';
import ModAssignee from '@/models/misc/ModAssignee.js';
import Player from '@/models/players/Player.js';
import User from '@/models/auth/User.js';
import {invalidatePublicModsCache} from './modCache.js';
import {indexCatalogMod, indexCatalogMods} from './modSearchIndex.js';
import {serializeMod, serializeMods, type SerializedMod} from './serializeMod.js';

export type AssignServiceError = {
  ok: false;
  status: number;
  error: string;
};

export type AssignServiceOk<T> = {ok: true} & T;

export function otherModIdsForSameCreator(
  current: {id: number; creatorDiscordId: string},
  allMods: {id: number; creatorDiscordId: string}[],
  alreadyAssignedModIds: Set<number>,
): number[] {
  return allMods
    .filter(
      (mod) =>
        mod.id !== current.id &&
        mod.creatorDiscordId === current.creatorDiscordId &&
        !alreadyAssignedModIds.has(mod.id),
    )
    .map((mod) => mod.id);
}

export function postedByAfterUnassign(
  postedByUserId: string | null | undefined,
  unassignedUserId: string,
): string | null {
  if (!postedByUserId) return null;
  return postedByUserId === unassignedUserId ? null : postedByUserId;
}

async function resolvePlayerUser(playerId: number): Promise<
  AssignServiceOk<{user: User}> | AssignServiceError
> {
  const player = await Player.findByPk(playerId, {attributes: ['id']});
  if (!player) return {ok: false, status: 404, error: 'Player not found'};
  const user = await User.findOne({
    where: {playerId},
    attributes: ['id', 'playerId', 'username', 'nickname'],
  });
  if (!user) return {ok: false, status: 400, error: 'This player has no TUF account'};
  return {ok: true, user};
}

export async function assignUserToMods(options: {
  modId: number;
  playerId: number;
  applyToSameCreator: boolean;
}): Promise<AssignServiceOk<{assignedModCount: number; mods: SerializedMod[]}> | AssignServiceError> {
  const resolved = await resolvePlayerUser(options.playerId);
  if (!resolved.ok) return resolved;

  const current = await Mod.findByPk(options.modId);
  if (!current) return {ok: false, status: 404, error: 'Mod not found'};

  const existingOnCurrent = await ModAssignee.findOne({
    where: {modId: current.id, userId: resolved.user.id},
  });
  if (existingOnCurrent) {
    return {ok: false, status: 400, error: 'User is already assigned to this mod'};
  }

  const targetIds = new Set<number>([current.id]);
  if (options.applyToSameCreator) {
    const sameCreator = await Mod.findAll({
      where: {creatorDiscordId: current.creatorDiscordId},
      attributes: ['id', 'creatorDiscordId'],
    });
    const alreadyRows = await ModAssignee.findAll({
      where: {
        userId: resolved.user.id,
        modId: {[Op.in]: sameCreator.map((mod) => mod.id)},
      },
      attributes: ['modId'],
    });
    const alreadyAssigned = new Set(alreadyRows.map((row) => row.modId));
    for (const id of otherModIdsForSameCreator(current, sameCreator, alreadyAssigned)) {
      targetIds.add(id);
    }
  }

  await ModAssignee.bulkCreate(
    [...targetIds].map((modId) => ({modId, userId: resolved.user.id})),
    {ignoreDuplicates: true},
  );
  await indexCatalogMods([...targetIds]);
  await invalidatePublicModsCache();

  const assignedMods = await Mod.findAll({
    where: {id: {[Op.in]: [...targetIds]}},
    order: [
      ['name', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return {
    ok: true,
    assignedModCount: targetIds.size,
    mods: await serializeMods(assignedMods, {includeHidden: true}),
  };
}

export async function unassignUserFromMod(options: {
  modId: number;
  userId: string;
}): Promise<AssignServiceOk<{mod: SerializedMod}> | AssignServiceError> {
  const mod = await Mod.findByPk(options.modId);
  if (!mod) return {ok: false, status: 404, error: 'Mod not found'};

  const row = await ModAssignee.findOne({
    where: {modId: mod.id, userId: options.userId},
  });
  if (!row) return {ok: false, status: 404, error: 'Assignee not found'};

  await row.destroy();
  const nextPostedBy = postedByAfterUnassign(mod.postedByUserId, options.userId);
  if (mod.postedByUserId !== nextPostedBy) {
    await mod.update({postedByUserId: nextPostedBy});
  }
  await invalidatePublicModsCache();
  await mod.reload();
  await indexCatalogMod(mod.id);
  return {ok: true, mod: await serializeMod(mod, {includeHidden: true})};
}

export async function listAssignedModsForUser(userId: string): Promise<SerializedMod[]> {
  const rows = await ModAssignee.findAll({
    where: {userId},
    attributes: ['modId'],
  });
  const ids = rows.map((row) => row.modId);
  if (!ids.length) return [];
  const mods = await Mod.findAll({
    where: {id: {[Op.in]: ids}},
    order: [
      ['name', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return serializeMods(mods, {includeHidden: true});
}

export async function userCanEditMod(modId: number, userId: string): Promise<Mod | null> {
  const row = await ModAssignee.findOne({
    where: {modId, userId},
    attributes: ['modId'],
  });
  if (!row) return null;
  return Mod.findByPk(modId);
}
