export const REFERENCE_CHANGE_KINDS = [
  'added',
  'removed',
  'type',
  'file',
  'rerated',
  'hidden',
  'deleted',
] as const;

export type ReferenceChangeKind = (typeof REFERENCE_CHANGE_KINDS)[number];

export function isReferenceChangeKind(value: string): value is ReferenceChangeKind {
  return (REFERENCE_CHANGE_KINDS as readonly string[]).includes(value);
}

export type ReferenceChartChangeKind = Extract<
  ReferenceChangeKind,
  'file' | 'rerated' | 'hidden' | 'deleted'
>;

function asFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function asText(value: unknown): string {
  return value == null ? '' : String(value);
}

function asNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Priority: deleted, then hidden, then file, then rerated.
 * Restoring a soft-deleted chart is not a listed kind; other field changes still apply.
 */
export function referenceChartChangeKind(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): ReferenceChartChangeKind | null {
  if (!after) {
    return before ? 'deleted' : null;
  }
  if (!before) return null;

  if (asFlag(after.isDeleted) && !asFlag(before.isDeleted)) return 'deleted';
  if (asFlag(after.isHidden) !== asFlag(before.isHidden)) return 'hidden';
  if (asText(after.fileId) !== asText(before.fileId) || asText(after.dlLink) !== asText(before.dlLink)) {
    return 'file';
  }
  if (asNumber(after.diffId) !== asNumber(before.diffId)) return 'rerated';
  return null;
}

export function referenceChangeDedupKey(args: {
  kind: ReferenceChangeKind;
  levelId: number;
  difficultyId?: number | null;
  type?: string | null;
  fileId?: string | null;
  dlLink?: string | null;
  diffId?: number | null;
  isHidden?: boolean;
}): string {
  const levelId = args.levelId;
  switch (args.kind) {
    case 'added':
    case 'removed':
      return `reference:${args.kind}:${args.difficultyId ?? 0}:${levelId}`;
    case 'type':
      return `reference:type:${args.difficultyId ?? 0}:${levelId}:${args.type ?? ''}`;
    case 'file':
      return `reference:file:${levelId}:${args.fileId || args.dlLink || ''}`;
    case 'rerated':
      return `reference:rerated:${levelId}:${args.diffId ?? ''}`;
    case 'hidden':
      return `reference:hidden:${levelId}:${args.isHidden ? '1' : '0'}`;
    case 'deleted':
      return `reference:deleted:${levelId}`;
  }
}

export function joinDifficultyNames(names: string[]): string {
  return names.filter(Boolean).join(', ');
}
