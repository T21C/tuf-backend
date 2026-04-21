/**
 * Redis Streams entries are flat string maps. CDC and outbox publishers use these field names.
 */
export const CDC_STREAM_FIELDS = {
  op: 'op',
  table: 'table',
  schema: 'schema',
  before: 'before',
  after: 'after',
  binlogFilename: 'binlogFilename',
  binlogPosition: 'binlogPosition',
} as const;

export const OUTBOX_STREAM_FIELDS = {
  id: 'id',
  eventType: 'eventType',
  aggregate: 'aggregate',
  aggregateId: 'aggregateId',
  payload: 'payload',
  dedupKey: 'dedupKey',
} as const;

export type CdcOp = 'c' | 'u' | 'd';

export interface CdcStreamMessage {
  op: CdcOp;
  table: string;
  schema: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  binlogFilename?: string;
  binlogPosition?: string;
}
