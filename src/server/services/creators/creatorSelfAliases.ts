import type { Sequelize } from 'sequelize';
import { literal, Transaction } from 'sequelize';
import { Op } from 'sequelize';
import Creator from '@/models/credits/Creator.js';
import { CreatorAlias } from '@/models/credits/CreatorAlias.js';

/** Self-service cap (admin popup uses the same limit in the client). */
export const MAX_CREATOR_ALIASES_SELF = 20;

const MIN_LEN = 2;
const MAX_LEN = 100;

export type ValidateCreatorAliasesResult =
  | { ok: true; names: string[] }
  | { ok: false; error: string };

function lowerEqNameEscaped(sequelize: Sequelize, value: string) {
  return literal(`LOWER(name) = LOWER(${sequelize.escape(value)})`);
}

/**
 * True if `identity` is already used as another creator's display name (case-insensitive).
 */
export async function creatorDisplayNameTakenByOther(
  sequelize: Sequelize,
  selfCreatorId: number,
  identity: string,
): Promise<boolean> {
  const row = await Creator.findOne({
    where: {
      id: { [Op.ne]: selfCreatorId },
      [Op.and]: lowerEqNameEscaped(sequelize, identity),
    },
    attributes: ['id'],
  });
  return Boolean(row);
}

/**
 * True if `identity` exists as any creator_alias row (any creator, including self).
 * Used so display names cannot collide with any alias string globally.
 */
export async function creatorAliasStringExistsGlobally(
  sequelize: Sequelize,
  identity: string,
): Promise<boolean> {
  const row = await CreatorAlias.findOne({
    where: {
      [Op.and]: lowerEqNameEscaped(sequelize, identity),
    },
    attributes: ['id'],
  });
  return Boolean(row);
}

/**
 * True if `identity` is used as another creator's primary name OR another creator's alias
 * (case-insensitive). Does not treat own display name as a conflict.
 */
export async function creatorIdentityTakenElsewhere(
  sequelize: Sequelize,
  selfCreatorId: number,
  identity: string,
): Promise<boolean> {
  if (await creatorDisplayNameTakenByOther(sequelize, selfCreatorId, identity)) return true;
  const aliasRow = await CreatorAlias.findOne({
    where: {
      creatorId: { [Op.ne]: selfCreatorId },
      [Op.and]: lowerEqNameEscaped(sequelize, identity),
    },
    attributes: ['id'],
  });
  return Boolean(aliasRow);
}

/**
 * Normalize and validate a replacement alias list for self-service.
 * Rules: max {@link MAX_CREATOR_ALIASES_SELF}, 2–100 chars each, trim, case-insensitive dedupe,
 * no alias may match this creator's display name (case-insensitive),
 * no alias may match any other creator's display name or any other creator's alias (case-insensitive).
 */
export async function validateCreatorAliasListForSelf(
  sequelize: Sequelize,
  creatorId: number,
  displayName: string,
  rawAliases: unknown,
): Promise<ValidateCreatorAliasesResult> {
  if (!Array.isArray(rawAliases)) {
    return { ok: false, error: 'Request body must include aliases: string[]' };
  }

  const names: string[] = [];
  const seenLower = new Set<string>();

  for (const item of rawAliases) {
    if (typeof item !== 'string') {
      return { ok: false, error: 'Each alias must be a string' };
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

  if (names.length > MAX_CREATOR_ALIASES_SELF) {
    return { ok: false, error: `At most ${MAX_CREATOR_ALIASES_SELF} aliases allowed` };
  }

  const displayKey = String(displayName ?? '').trim().toLowerCase();
  for (const n of names) {
    if (n.toLowerCase() === displayKey) {
      return { ok: false, error: 'An alias cannot match your display name' };
    }
    if (await creatorIdentityTakenElsewhere(sequelize, creatorId, n)) {
      return {
        ok: false,
        error: `Name "${n}" is already used by another creator or alias`,
      };
    }
  }

  return { ok: true, names };
}

export async function replaceCreatorAliasesForCreator(
  creatorId: number,
  names: string[],
  transaction: Transaction,
): Promise<void> {
  await CreatorAlias.destroy({ where: { creatorId }, transaction });
  if (names.length === 0) {
    return;
  }
  await CreatorAlias.bulkCreate(
    names.map((name) => ({ creatorId, name })),
    { transaction },
  );
}
