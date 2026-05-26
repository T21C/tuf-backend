import type {Sequelize} from 'sequelize';
import {literal, Op, Transaction} from 'sequelize';
import Player from '@/models/players/Player.js';
import PlayerAlias from '@/models/players/PlayerAlias.js';
import Creator from '@/models/credits/Creator.js';
import {CreatorAlias} from '@/models/credits/CreatorAlias.js';

export const MAX_PLAYER_ALIASES = 20;

const MIN_LEN = 2;
const MAX_LEN = 100;

export type ValidatePlayerAliasesResult =
  | {ok: true; names: string[]}
  | {ok: false; error: string};

function lowerEqNameEscaped(sequelize: Sequelize, value: string) {
  return literal(`LOWER(name) = LOWER(${sequelize.escape(value)})`);
}

export async function playerDisplayNameTakenByOther(
  sequelize: Sequelize,
  selfPlayerId: number,
  identity: string,
): Promise<boolean> {
  const row = await Player.findOne({
    where: {
      id: {[Op.ne]: selfPlayerId},
      [Op.and]: lowerEqNameEscaped(sequelize, identity),
    },
    attributes: ['id'],
  });
  return Boolean(row);
}

export async function playerAliasStringExistsGlobally(
  sequelize: Sequelize,
  identity: string,
): Promise<boolean> {
  const row = await PlayerAlias.findOne({
    where: {[Op.and]: lowerEqNameEscaped(sequelize, identity)},
    attributes: ['id'],
  });
  return Boolean(row);
}

export async function playerIdentityTakenElsewhere(
  sequelize: Sequelize,
  selfPlayerId: number,
  identity: string,
): Promise<boolean> {
  if (await playerDisplayNameTakenByOther(sequelize, selfPlayerId, identity)) return true;
  const aliasRow = await PlayerAlias.findOne({
    where: {
      playerId: {[Op.ne]: selfPlayerId},
      [Op.and]: lowerEqNameEscaped(sequelize, identity),
    },
    attributes: ['id'],
  });
  return Boolean(aliasRow);
}

/** Creator display name or alias (case-insensitive) — avoids ambiguous global search identities. */
export async function creatorIdentityExistsGlobally(
  sequelize: Sequelize,
  identity: string,
): Promise<boolean> {
  const creatorRow = await Creator.findOne({
    where: {[Op.and]: lowerEqNameEscaped(sequelize, identity)},
    attributes: ['id'],
  });
  if (creatorRow) return true;
  const aliasRow = await CreatorAlias.findOne({
    where: {[Op.and]: lowerEqNameEscaped(sequelize, identity)},
    attributes: ['id'],
  });
  return Boolean(aliasRow);
}

export async function playerIdentityTakenGlobally(
  sequelize: Sequelize,
  selfPlayerId: number,
  identity: string,
): Promise<boolean> {
  if (await playerIdentityTakenElsewhere(sequelize, selfPlayerId, identity)) return true;
  return creatorIdentityExistsGlobally(sequelize, identity);
}

export async function countPlayerAliases(playerId: number, transaction?: Transaction): Promise<number> {
  return PlayerAlias.count({where: {playerId}, transaction});
}

export async function playerHasAlias(
  playerId: number,
  name: string,
  transaction?: Transaction,
): Promise<boolean> {
  const seq = Player.sequelize!;
  const row = await PlayerAlias.findOne({
    where: {
      playerId,
      [Op.and]: lowerEqNameEscaped(seq, name.trim()),
    },
    attributes: ['id'],
    transaction,
  });
  return Boolean(row);
}

export async function validatePlayerAliasListForAdmin(
  sequelize: Sequelize,
  playerId: number,
  displayName: string,
  rawAliases: unknown,
): Promise<ValidatePlayerAliasesResult> {
  if (!Array.isArray(rawAliases)) {
    return {ok: false, error: 'Request body must include aliases: string[]'};
  }

  const names: string[] = [];
  const seenLower = new Set<string>();

  for (const item of rawAliases) {
    if (typeof item !== 'string') {
      return {ok: false, error: 'Each alias must be a string'};
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length < MIN_LEN || trimmed.length > MAX_LEN) {
      return {
        ok: false,
        error: `Each alias must be between ${MIN_LEN} and ${MAX_LEN} characters`,
      };
    }
    const key = trimmed.toLowerCase();
    if (seenLower.has(key)) continue;
    seenLower.add(key);
    names.push(trimmed);
  }

  if (names.length > MAX_PLAYER_ALIASES) {
    return {ok: false, error: `At most ${MAX_PLAYER_ALIASES} aliases allowed`};
  }

  const displayKey = String(displayName ?? '').trim().toLowerCase();
  for (const n of names) {
    if (n.toLowerCase() === displayKey) {
      return {ok: false, error: 'An alias cannot match the player display name'};
    }
    if (await playerIdentityTakenGlobally(sequelize, playerId, n)) {
      return {
        ok: false,
        error: `Name "${n}" is already used by another player, player alias, or creator`,
      };
    }
  }

  return {ok: true, names};
}

export async function replacePlayerAliasesForPlayer(
  playerId: number,
  names: string[],
  transaction: Transaction,
): Promise<void> {
  await PlayerAlias.destroy({where: {playerId}, transaction});
  if (names.length === 0) return;
  await PlayerAlias.bulkCreate(
    names.map((name) => ({playerId, name})),
    {transaction},
  );
}
