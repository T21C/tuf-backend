import type {Sequelize} from 'sequelize';
import {literal, Op, Transaction} from 'sequelize';
import Team from '@/models/credits/Team.js';
import {TeamAlias} from '@/models/credits/TeamAlias.js';

/** Admin / API cap for team aliases (matches creator/player norms). */
export const MAX_TEAM_ALIASES = 100;

const MIN_LEN = 2;
const MAX_LEN = 100;

export type ValidateTeamNameResult =
  | {ok: true; name: string}
  | {ok: false; error: string};

export type ValidateTeamAliasesResult =
  | {ok: true; names: string[]}
  | {ok: false; error: string};

function lowerEqNameEscaped(sequelize: Sequelize, value: string) {
  return literal(`LOWER(name) = LOWER(${sequelize.escape(value)})`);
}

/**
 * True if `identity` is already used as another team's display name (case-insensitive).
 * Pass `selfTeamId = null` when creating a team.
 */
export async function teamDisplayNameTakenByOther(
  sequelize: Sequelize,
  selfTeamId: number | null,
  identity: string,
  transaction?: Transaction,
): Promise<boolean> {
  const where: Record<string | symbol, unknown> = {
    [Op.and]: lowerEqNameEscaped(sequelize, identity),
  };
  if (selfTeamId != null) {
    where.id = {[Op.ne]: selfTeamId};
  }
  const row = await Team.findOne({
    where,
    attributes: ['id'],
    transaction,
  });
  return Boolean(row);
}

/**
 * True if `identity` exists as a team_aliases row for another team (case-insensitive).
 * Pass `selfTeamId = null` to check all teams.
 */
export async function teamAliasStringExistsElsewhere(
  sequelize: Sequelize,
  selfTeamId: number | null,
  identity: string,
  transaction?: Transaction,
): Promise<boolean> {
  const where: Record<string | symbol, unknown> = {
    [Op.and]: lowerEqNameEscaped(sequelize, identity),
  };
  if (selfTeamId != null) {
    where.teamId = {[Op.ne]: selfTeamId};
  }
  const row = await TeamAlias.findOne({
    where,
    attributes: ['id'],
    transaction,
  });
  return Boolean(row);
}

/**
 * True if `identity` is used as another team's primary name OR another team's alias
 * (case-insensitive). Does not treat own display name as a conflict.
 */
export async function teamIdentityTakenElsewhere(
  sequelize: Sequelize,
  selfTeamId: number | null,
  identity: string,
  transaction?: Transaction,
): Promise<boolean> {
  if (await teamDisplayNameTakenByOther(sequelize, selfTeamId, identity, transaction)) {
    return true;
  }
  return teamAliasStringExistsElsewhere(sequelize, selfTeamId, identity, transaction);
}

/**
 * Normalize and validate a team display name.
 */
export async function validateTeamName(
  sequelize: Sequelize,
  selfTeamId: number | null,
  rawName: unknown,
  transaction?: Transaction,
): Promise<ValidateTeamNameResult> {
  if (typeof rawName !== 'string') {
    return {ok: false, error: 'Team name is required'};
  }
  const name = rawName.trim();
  if (name.length === 0) {
    return {ok: false, error: 'Team name is required'};
  }
  if (name.length < MIN_LEN || name.length > MAX_LEN) {
    return {
      ok: false,
      error: `Team name must be between ${MIN_LEN} and ${MAX_LEN} characters`,
    };
  }
  if (await teamIdentityTakenElsewhere(sequelize, selfTeamId, name, transaction)) {
    return {
      ok: false,
      error: `A team with the name "${name}" already exists`,
    };
  }
  return {ok: true, name};
}

/**
 * Normalize and validate a replacement alias list.
 * Rules: max {@link MAX_TEAM_ALIASES}, 2–100 chars each, trim, case-insensitive dedupe,
 * no alias may match this team's display name,
 * no alias may match any other team's display name or alias.
 */
export async function validateTeamAliasList(
  sequelize: Sequelize,
  teamId: number | null,
  displayName: string,
  rawAliases: unknown,
  transaction?: Transaction,
): Promise<ValidateTeamAliasesResult> {
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
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.length < MIN_LEN || trimmed.length > MAX_LEN) {
      return {
        ok: false,
        error: `Each alias must be between ${MIN_LEN} and ${MAX_LEN} characters`,
      };
    }
    const key = trimmed.toLowerCase();
    if (seenLower.has(key)) {
      continue;
    }
    seenLower.add(key);
    names.push(trimmed);
  }

  if (names.length > MAX_TEAM_ALIASES) {
    return {ok: false, error: `At most ${MAX_TEAM_ALIASES} aliases allowed`};
  }

  const displayKey = String(displayName ?? '').trim().toLowerCase();
  for (const n of names) {
    if (n.toLowerCase() === displayKey) {
      return {ok: false, error: 'An alias cannot match the team display name'};
    }
    if (await teamIdentityTakenElsewhere(sequelize, teamId, n, transaction)) {
      return {
        ok: false,
        error: `Name "${n}" is already used by another team or alias`,
      };
    }
  }

  return {ok: true, names};
}

export async function replaceTeamAliases(
  teamId: number,
  names: string[],
  transaction: Transaction,
): Promise<void> {
  await TeamAlias.destroy({where: {teamId}, transaction});
  if (names.length === 0) {
    return;
  }
  await TeamAlias.bulkCreate(
    names.map(name => ({teamId, name})),
    {transaction},
  );
}
