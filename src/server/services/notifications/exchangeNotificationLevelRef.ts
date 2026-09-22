export interface NotificationLevelRef {
  payload: unknown;
  entityType: string | null;
  entityId: string | null;
}

export interface ExchangedNotificationLevelRef {
  payload: unknown;
  entityId: string | null;
  changed: boolean;
}

/** Payload fields that store a level id. Pass, player, and submission ids stay put. */
const LEVEL_ID_PAYLOAD_KEYS = ['levelId', 'swappedWithLevelId'] as const;

function asLevelId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function exchangedId(id: number, levelIdA: number, levelIdB: number): number | null {
  if (id === levelIdA) return levelIdB;
  if (id === levelIdB) return levelIdA;
  return null;
}

/**
 * Point a stored notification at the level id that now holds the same chart.
 * Song and artist snapshots stay; only level ids exchange, matching a payload swap.
 */
export function exchangeNotificationLevelRef(
  row: NotificationLevelRef,
  levelIdA: number,
  levelIdB: number,
): ExchangedNotificationLevelRef {
  let changed = false;
  let payload = row.payload;
  let entityId = row.entityId;

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    let nextPayload: Record<string, unknown> | null = null;
    for (const key of LEVEL_ID_PAYLOAD_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const current = asLevelId(record[key]);
      if (current == null) continue;
      const next = exchangedId(current, levelIdA, levelIdB);
      if (next == null) continue;
      nextPayload = nextPayload ?? {...record};
      nextPayload[key] = next;
      changed = true;
    }
    if (nextPayload) payload = nextPayload;
  }

  if (row.entityType === 'level') {
    const current = asLevelId(entityId);
    if (current != null) {
      const next = exchangedId(current, levelIdA, levelIdB);
      if (next != null) {
        entityId = String(next);
        changed = true;
      }
    }
  }

  return {payload, entityId, changed};
}
