import type {Transaction} from 'sequelize';
import Player from '@/models/players/Player.js';
import Creator from '@/models/credits/Creator.js';
import ProfileNote, {
  PROFILE_NOTE_MAX_LENGTH,
  PROFILE_NOTE_TARGET_TYPES,
  type ProfileNoteTargetType,
} from '@/models/notifications/ProfileNote.js';
import {mapMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';

export {PROFILE_NOTE_MAX_LENGTH, PROFILE_NOTE_TARGET_TYPES, type ProfileNoteTargetType};

export class ProfileNoteError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProfileNoteError';
    this.status = status;
  }
}

export type ParseProfileNoteResult =
  | {ok: true; text: string | null}
  | {ok: false; error: string; status: number};

export function isProfileNoteTargetType(value: string): value is ProfileNoteTargetType {
  return (PROFILE_NOTE_TARGET_TYPES as readonly string[]).includes(value);
}

/** Trim ends only. Empty → null (delete). Over 2000 after trim → 400, never slice. */
export function parseProfileNoteText(input: unknown): ParseProfileNoteResult {
  if (typeof input !== 'string') {
    return {ok: false, error: 'text must be a string', status: 400};
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return {ok: true, text: null};
  }
  if (trimmed.length > PROFILE_NOTE_MAX_LENGTH) {
    return {
      ok: false,
      error: `text cannot exceed ${PROFILE_NOTE_MAX_LENGTH} characters`,
      status: 400,
    };
  }
  return {ok: true, text: trimmed};
}

async function assertTargetExists(
  targetType: ProfileNoteTargetType,
  targetId: number,
  transaction?: Transaction,
): Promise<void> {
  if (targetType === 'player') {
    const player = await Player.findByPk(targetId, {attributes: ['id'], transaction});
    if (!player) throw new ProfileNoteError('Player not found', 404);
    return;
  }
  const creator = await Creator.findByPk(targetId, {attributes: ['id'], transaction});
  if (!creator) throw new ProfileNoteError('Creator not found', 404);
}

export async function getViewerNote(
  userId: string | null | undefined,
  targetType: ProfileNoteTargetType,
  targetId: number,
  transaction?: Transaction,
): Promise<string | null> {
  if (!userId || !Number.isInteger(targetId) || targetId <= 0) return null;
  const row = await ProfileNote.findOne({
    where: {userId, targetType, targetId},
    attributes: ['text'],
    transaction,
  });
  return row?.text ?? null;
}

export async function setViewerNote(args: {
  userId: string;
  targetType: ProfileNoteTargetType;
  targetId: number;
  text: unknown;
  transaction?: Transaction;
}): Promise<string | null> {
  const {userId, targetType, targetId, transaction} = args;
  if (!Number.isInteger(targetId) || targetId <= 0) {
    throw new ProfileNoteError('Invalid target id', 400);
  }
  const parsed = parseProfileNoteText(args.text);
  if (!parsed.ok) {
    throw new ProfileNoteError(parsed.error, parsed.status);
  }
  await assertTargetExists(targetType, targetId, transaction);

  const existing = await ProfileNote.findOne({
    where: {userId, targetType, targetId},
    transaction,
  });

  if (parsed.text == null) {
    if (existing) await existing.destroy({transaction});
    return null;
  }

  if (existing) {
    existing.text = parsed.text;
    await existing.save({transaction});
    return existing.text;
  }

  try {
    const created = await ProfileNote.create(
      {userId, targetType, targetId, text: parsed.text},
      {transaction},
    );
    return created.text;
  } catch (err) {
    if (mapMysqlClientError(err)?.code !== 'ER_DUP_ENTRY') throw err;
    await ProfileNote.update(
      {text: parsed.text},
      {where: {userId, targetType, targetId}, transaction},
    );
    return parsed.text;
  }
}
