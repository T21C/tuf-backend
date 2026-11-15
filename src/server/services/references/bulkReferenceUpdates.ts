export type BulkReferenceUpdate = {
  levelId: number;
  type: string;
};

export class BulkReferencePayloadError extends Error {
  invalidLevelIds: unknown[];

  constructor(message: string, invalidLevelIds: unknown[] = []) {
    super(message);
    this.name = 'BulkReferencePayloadError';
    this.invalidLevelIds = invalidLevelIds;
  }
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function isDeletedFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

/** Last entry wins when the same levelId appears more than once. */
export function normalizeBulkReferenceUpdates(input: unknown): BulkReferenceUpdate[] {
  if (!Array.isArray(input)) {
    throw new BulkReferencePayloadError('references must be an array');
  }

  const byLevelId = new Map<number, BulkReferenceUpdate>();
  const invalidLevelIds: unknown[] = [];

  for (const item of input) {
    if (item == null || typeof item !== 'object') {
      invalidLevelIds.push(item);
      continue;
    }

    const rawId = (item as {levelId?: unknown}).levelId;
    const levelId = parsePositiveInt(rawId);
    if (levelId == null) {
      invalidLevelIds.push(rawId);
      continue;
    }

    const typeRaw = (item as {type?: unknown}).type;
    const type = typeRaw == null ? '' : String(typeRaw);
    byLevelId.set(levelId, {levelId, type});
  }

  if (invalidLevelIds.length > 0) {
    throw new BulkReferencePayloadError(
      `Invalid level ID(s): ${invalidLevelIds.map((id) => String(id ?? 'empty')).join(', ')}`,
      invalidLevelIds,
    );
  }

  return [...byLevelId.values()];
}

export function findUnavailableLevelIds(
  requestedIds: readonly number[],
  existing: ReadonlyArray<{id: unknown; isDeleted?: unknown}>,
): number[] {
  const available = new Set<number>();
  for (const row of existing) {
    const id = Number(row.id);
    if (Number.isInteger(id) && id > 0 && !isDeletedFlag(row.isDeleted)) {
      available.add(id);
    }
  }
  return requestedIds.filter((id) => !available.has(id));
}
