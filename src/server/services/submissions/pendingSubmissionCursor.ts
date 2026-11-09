import { Op, type WhereOptions } from 'sequelize';

export const PENDING_SUBMISSION_PAGE_DEFAULT = 15;
export const PENDING_SUBMISSION_PAGE_MAX = 30;

export type PendingSubmissionCursor = {
  isLocked: 0 | 1;
  createdAt: string;
  id: number;
};

export type PendingSubmissionListQuery = {
  limit: number;
  cursor: PendingSubmissionCursor | null;
  q: string;
  ids: number[] | null;
};

type PendingRowKey = {
  id: number;
  isLocked?: boolean | number | null;
  createdAt: Date | string;
};

function queryString(value: unknown): string {
  if (Array.isArray(value)) return queryString(value[0]);
  return typeof value === 'string' ? value : '';
}

export function cursorFromPendingRow(row: PendingRowKey): PendingSubmissionCursor {
  const time = new Date(row.createdAt).getTime();
  return {
    isLocked: row.isLocked ? 1 : 0,
    createdAt: new Date(time).toISOString(),
    id: row.id,
  };
}

export function encodePendingSubmissionCursor(cursor: PendingSubmissionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodePendingSubmissionCursor(raw: unknown): PendingSubmissionCursor | null {
  const encoded = queryString(raw).trim();
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      isLocked?: unknown;
      createdAt?: unknown;
      id?: unknown;
    };
    const isLocked = parsed.isLocked === 1 || parsed.isLocked === true
      ? 1
      : parsed.isLocked === 0 || parsed.isLocked === false
        ? 0
        : null;
    const id = Number(parsed.id);
    const createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : '';
    const time = Date.parse(createdAt);
    if (isLocked === null || !Number.isInteger(id) || id <= 0 || Number.isNaN(time)) return null;
    return { isLocked, createdAt: new Date(time).toISOString(), id };
  } catch {
    return null;
  }
}

export function parsePendingSubmissionListQuery(query: {
  limit?: unknown;
  cursor?: unknown;
  q?: unknown;
  ids?: unknown;
}): PendingSubmissionListQuery | { error: string } {
  const limitRaw = queryString(query.limit).trim();
  let limit = PENDING_SUBMISSION_PAGE_DEFAULT;
  if (limitRaw) {
    const parsedLimit = Number(limitRaw);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > PENDING_SUBMISSION_PAGE_MAX) {
      return { error: `limit must be an integer from 1 to ${PENDING_SUBMISSION_PAGE_MAX}` };
    }
    limit = parsedLimit;
  }

  const cursorRaw = queryString(query.cursor).trim();
  const cursor = cursorRaw ? decodePendingSubmissionCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) return { error: 'Invalid cursor' };

  const idsRaw = queryString(query.ids).trim();
  let ids: number[] | null = null;
  if (idsRaw) {
    const parsedIds = idsRaw.split(',').map((part) => Number(part.trim()));
    if (
      parsedIds.length === 0
      || parsedIds.length > PENDING_SUBMISSION_PAGE_MAX
      || parsedIds.some((id) => !Number.isInteger(id) || id <= 0)
    ) {
      return { error: `ids must be 1 to ${PENDING_SUBMISSION_PAGE_MAX} positive integers` };
    }
    ids = parsedIds;
  }

  return {
    limit,
    cursor,
    q: queryString(query.q).trim(),
    ids,
  };
}

/** Rows strictly after the cursor in (isLocked ASC, createdAt DESC, id DESC) order. */
export function pendingKeysetWhere(cursor: PendingSubmissionCursor): WhereOptions {
  const createdAt = new Date(cursor.createdAt);
  const isLocked = cursor.isLocked;
  return {
    [Op.or]: [
      { isLocked: { [Op.gt]: isLocked } },
      { [Op.and]: [{ isLocked }, { createdAt: { [Op.lt]: createdAt } }] },
      { [Op.and]: [{ isLocked }, { createdAt }, { id: { [Op.lt]: cursor.id } }] },
    ],
  };
}

export function isAfterPendingCursor(row: PendingRowKey, cursor: PendingSubmissionCursor): boolean {
  const locked = row.isLocked ? 1 : 0;
  if (locked !== cursor.isLocked) return locked > cursor.isLocked;
  const time = new Date(row.createdAt).getTime();
  const cursorTime = Date.parse(cursor.createdAt);
  if (time !== cursorTime) return time < cursorTime;
  return row.id < cursor.id;
}

export function comparePendingSubmissions(a: PendingRowKey, b: PendingRowKey): number {
  const lockDelta = (a.isLocked ? 1 : 0) - (b.isLocked ? 1 : 0);
  if (lockDelta !== 0) return lockDelta;
  const timeDelta = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  if (timeDelta !== 0) return timeDelta;
  return b.id - a.id;
}

export function pendingQueueRevision(total: number, latest: Date | string | number | null | undefined): string {
  const count = Number.isFinite(total) ? total : 0;
  if (latest == null || latest === '') return `${count}:0`;
  const latestMs = new Date(latest).getTime();
  return `${count}:${Number.isFinite(latestMs) ? latestMs : 0}`;
}
