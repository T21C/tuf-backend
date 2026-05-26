import type {Transaction} from 'sequelize';
import {UniqueConstraintError} from 'sequelize';
import PlayerAlias from '@/models/players/PlayerAlias.js';
import {CreatorAlias} from '@/models/credits/CreatorAlias.js';

function isUniqueConstraintError(error: unknown): boolean {
  if (error instanceof UniqueConstraintError) return true;
  const e = error as {name?: string; parent?: {code?: string}};
  return e?.name === 'SequelizeUniqueConstraintError' || e?.parent?.code === 'ER_DUP_ENTRY';
}

function namesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function appendPlayerAliasSimple(
  playerId: number,
  name: string,
  transaction?: Transaction,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;

  try {
    await PlayerAlias.create({playerId, name: trimmed}, {transaction});
  } catch (error) {
    if (isUniqueConstraintError(error)) return;
    throw error;
  }
}

export async function appendCreatorAliasSimple(
  creatorId: number,
  name: string,
  transaction?: Transaction,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;

  try {
    await CreatorAlias.create({creatorId, name: trimmed}, {transaction});
  } catch (error) {
    if (isUniqueConstraintError(error)) return;
    throw error;
  }
}

export async function appendPlayerAliasFromRename(
  playerId: number,
  previousName: string,
  nextName: string,
  transaction?: Transaction,
): Promise<void> {
  const prev = previousName.trim();
  const next = nextName.trim();
  if (!prev || namesEqual(prev, next)) return;
  await appendPlayerAliasSimple(playerId, prev, transaction);
}

export async function appendCreatorAliasFromRename(
  creatorId: number,
  previousName: string,
  nextName: string,
  transaction?: Transaction,
): Promise<void> {
  const prev = previousName.trim();
  const next = nextName.trim();
  if (!prev || namesEqual(prev, next)) return;
  await appendCreatorAliasSimple(creatorId, prev, transaction);
}

export async function migratePlayerAliasesOnMerge(
  sourcePlayerId: number,
  targetPlayerId: number,
  sourcePlayerName: string,
  transaction: Transaction,
): Promise<void> {
  const rows = await PlayerAlias.findAll({
    where: {playerId: sourcePlayerId},
    attributes: ['name'],
    transaction,
  });

  if (rows.length > 0) {
    await PlayerAlias.bulkCreate(
      rows.map((row) => ({playerId: targetPlayerId, name: row.name})),
      {transaction, ignoreDuplicates: true},
    );
  }

  await appendPlayerAliasSimple(targetPlayerId, sourcePlayerName, transaction);
}
