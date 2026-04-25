import { CDC_STREAM_FIELDS } from '@/server/services/eventBus/types.js';
import type { CdcOp } from '@/server/services/eventBus/types.js';

export function parseCdcFields(fields: Record<string, string>): {
  op: CdcOp;
  table: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
} {
  const opRaw = fields[CDC_STREAM_FIELDS.op] ?? 'u';
  const op: CdcOp = opRaw === 'c' || opRaw === 'u' || opRaw === 'd' ? opRaw : 'u';
  const table = fields[CDC_STREAM_FIELDS.table] ?? '';
  let before: Record<string, unknown> | null = null;
  let after: Record<string, unknown> | null = null;
  const b = fields[CDC_STREAM_FIELDS.before];
  const a = fields[CDC_STREAM_FIELDS.after];
  if (b) {
    try {
      before = JSON.parse(b) as Record<string, unknown>;
    } catch {
      before = null;
    }
  }
  if (a) {
    try {
      after = JSON.parse(a) as Record<string, unknown>;
    } catch {
      after = null;
    }
  }
  return { op, table, before, after };
}

export function rowId(before: Record<string, unknown> | null, after: Record<string, unknown> | null): number | null {
  const id = (after?.id ?? before?.id) as unknown;
  if (typeof id === 'number' && Number.isFinite(id)) return id;
  if (typeof id === 'string' && id !== '' && !Number.isNaN(Number(id))) return Number(id);
  return null;
}
