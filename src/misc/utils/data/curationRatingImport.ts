import {assignCurationFlow, type CurationFlowId} from './curationFlow.js';

export type CurationSheetRow = {
  levelId: number | null;
  comments: string;
  bulk: boolean;
  isRated: string;
};

export type CurationImportTarget = {
  levelId: number;
  flow: CurationFlowId;
  reason: string;
};

const DONE_MARK = /^wow,\s*this is done!/i;

export function parseCsvRecords(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    cell += char;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim() !== '')) rows.push(row);
  }
  return rows;
}

function headerIndex(header: string[], names: string[]): number {
  const wanted = new Set(names.map((name) => name.trim().toLowerCase()));
  return header.findIndex((cell) => wanted.has(cell.trim().toLowerCase()));
}

function parseSheetLevelId(value: string): number | null {
  const match = String(value || '').trim().match(/(\d+)/);
  if (!match) return null;
  const id = Number(match[1]);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function parseSheetBulk(value: string): boolean {
  return /^(true|1|yes)$/i.test(String(value || '').trim());
}

export function parseCurationSheetCsv(text: string): CurationSheetRow[] {
  const records = parseCsvRecords(text);
  if (records.length === 0) return [];
  const header = records[0];
  const idIdx = headerIndex(header, ['tuf id', 'tufid', 'id']);
  const commentsIdx = headerIndex(header, ['comments']);
  const ratedIdx = headerIndex(header, ['is rated?', 'is rated', 'israted']);
  const bulkIdx = headerIndex(header, ['bulk']);
  if (idIdx < 0) {
    throw new Error('Sheet CSV is missing a TUF ID column');
  }
  const rows: CurationSheetRow[] = [];
  for (const record of records.slice(1)) {
    rows.push({
      levelId: parseSheetLevelId(record[idIdx] ?? ''),
      comments: commentsIdx >= 0 ? String(record[commentsIdx] ?? '').trim() : '',
      bulk: bulkIdx >= 0 ? parseSheetBulk(record[bulkIdx] ?? '') : false,
      isRated: ratedIdx >= 0 ? String(record[ratedIdx] ?? '') : '',
    });
  }
  return rows;
}

/** Unique positive ids from a comma, space, or newline separated list. */
export function parseRecentIdList(text: string): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const part of String(text || '').split(/[^\d]+/)) {
    if (!part) continue;
    const id = Number(part);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function sheetRowIsDone(isRated: string): boolean {
  return DONE_MARK.test(String(isRated || '').trim());
}

export function lastNonEmptyComment(comments: Iterable<string>): string {
  let last = '';
  for (const comment of comments) {
    const text = String(comment || '').trim();
    if (text) last = text;
  }
  return last;
}

function mergeRow(
  existing: {comments: string[]; bulk: boolean; done: boolean} | undefined,
  row: CurationSheetRow,
): {comments: string[]; bulk: boolean; done: boolean} {
  const next = existing ?? {comments: [], bulk: false, done: false};
  if (row.comments.trim()) next.comments.push(row.comments);
  if (row.bulk) next.bulk = true;
  if (sheetRowIsDone(row.isRated)) next.done = true;
  return next;
}

/**
 * Recent list wins over Bulk. Charts marked done stay off Bulk, and stay on
 * Recent when they appear in that list. Missing TUF ids are ignored.
 */
export function selectCurationImportTargets(input: {
  recentIds: number[];
  sheetRows: CurationSheetRow[];
}): {
  targets: CurationImportTarget[];
  skippedNoId: number;
  skippedDone: number;
} {
  const byId = new Map<number, {comments: string[]; bulk: boolean; done: boolean}>();
  let skippedNoId = 0;
  for (const row of input.sheetRows) {
    if (row.levelId == null || !Number.isInteger(row.levelId) || row.levelId <= 0) {
      skippedNoId += 1;
      continue;
    }
    byId.set(row.levelId, mergeRow(byId.get(row.levelId), row));
  }

  const recentSet = new Set(input.recentIds.filter((id) => Number.isInteger(id) && id > 0));
  const targets: CurationImportTarget[] = [];
  const queued = new Set<number>();
  let skippedDone = 0;

  for (const levelId of recentSet) {
    const row = byId.get(levelId);
    targets.push({
      levelId,
      flow: 'recent',
      reason: lastNonEmptyComment(row?.comments ?? []),
    });
    queued.add(levelId);
  }

  for (const [levelId, row] of byId) {
    if (queued.has(levelId)) continue;
    if (!row.bulk) continue;
    if (row.done) {
      skippedDone += 1;
      continue;
    }
    targets.push({
      levelId,
      flow: assignCurationFlow({bulk: true}),
      reason: lastNonEmptyComment(row.comments),
    });
  }

  return {targets, skippedNoId, skippedDone};
}
