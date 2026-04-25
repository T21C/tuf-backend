import { CDC_STREAM_PREFIX } from './constants.js';
import { CDC_STREAM_FIELDS } from '@/server/services/eventBus/types.js';
import type { CdcOp } from '@/server/services/eventBus/types.js';

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Buffer) {
    return { __buf: 'base64', v: value.toString('base64') };
  }
  return value;
}

function serializeRow(row: Record<string, unknown> | null): string {
  if (row == null) return '';
  try {
    return JSON.stringify(row, jsonReplacer);
  } catch {
    return '{}';
  }
}

export async function publishCdcRow(args: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  table: string;
  schema: string;
  op: CdcOp;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  binlogFilename: string;
  binlogPosition: number;
}): Promise<void> {
  const streamKey = `${CDC_STREAM_PREFIX}${args.table}`;
  await args.client.xAdd(streamKey, '*', {
    [CDC_STREAM_FIELDS.op]: args.op,
    [CDC_STREAM_FIELDS.table]: args.table,
    [CDC_STREAM_FIELDS.schema]: args.schema,
    [CDC_STREAM_FIELDS.before]: serializeRow(args.before),
    [CDC_STREAM_FIELDS.after]: serializeRow(args.after),
    [CDC_STREAM_FIELDS.binlogFilename]: args.binlogFilename,
    [CDC_STREAM_FIELDS.binlogPosition]: String(args.binlogPosition),
  });
}
