export const CURATION_FLOWS = ['recent', 'rerate', 'bulk'] as const;
export type CurationFlowId = (typeof CURATION_FLOWS)[number];

export type ZenCurationPoolFlags = {
  includeRecent: boolean;
  includeRerate: boolean;
  includeBulk: boolean;
};

export type CurationListFlowFilter =
  | {kind: 'all'}
  | {kind: 'one'; flow: CurationFlowId}
  | {kind: 'some'; flows: CurationFlowId[]}
  | {kind: 'none'};

const ZEN_POOL_FLAGS: {flow: CurationFlowId; key: keyof ZenCurationPoolFlags}[] = [
  {flow: 'recent', key: 'includeRecent'},
  {flow: 'rerate', key: 'includeRerate'},
  {flow: 'bulk', key: 'includeBulk'},
];

function asIncludeFlag(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return fallback;
}

export function parseCurationFlow(value: unknown): CurationFlowId | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'recent' || text === 'rerate' || text === 'bulk') return text;
  return null;
}

/** Include flags for curation Zen. Missing flags stay on, same as P/G/U. */
export function parseZenCurationPools(body: Record<string, unknown>): ZenCurationPoolFlags {
  return {
    includeRecent: asIncludeFlag(body.includeRecent, true),
    includeRerate: asIncludeFlag(body.includeRerate, true),
    includeBulk: asIncludeFlag(body.includeBulk, true),
  };
}

/**
 * null means every pool, so the list query adds no flow predicate.
 * An empty array means the deck should be empty.
 */
export function curationFlowsForZenPools(flags: ZenCurationPoolFlags): CurationFlowId[] | null {
  const flows = ZEN_POOL_FLAGS.filter((entry) => flags[entry.key]).map((entry) => entry.flow);
  if (flows.length === CURATION_FLOWS.length) return null;
  return flows;
}

/** Single-tab `flow` unless an explicit `flows` list was passed (Zen pool picker). */
export function resolveCurationListFlows(
  flow: CurationFlowId | null,
  flows: readonly unknown[] | null | undefined,
): CurationListFlowFilter {
  if (Array.isArray(flows)) {
    const selected: CurationFlowId[] = [];
    const seen = new Set<CurationFlowId>();
    for (const raw of flows) {
      const parsed = parseCurationFlow(raw);
      if (!parsed || seen.has(parsed)) continue;
      seen.add(parsed);
      selected.push(parsed);
    }
    if (selected.length === 0) return {kind: 'none'};
    if (selected.length >= CURATION_FLOWS.length) return {kind: 'all'};
    return {kind: 'some', flows: selected};
  }
  if (flow) return {kind: 'one', flow};
  return {kind: 'all'};
}

export function assignCurationFlow(input: {
  bulk?: boolean;
  hasPublishedCuration?: boolean;
  explicit?: CurationFlowId | null;
}): CurationFlowId {
  if (input.explicit) return input.explicit;
  if (input.bulk) return 'bulk';
  if (input.hasPublishedCuration) return 'rerate';
  return 'recent';
}

export function curationFlowForRequestType(type: string | null | undefined): CurationFlowId | null {
  if (type === 'curation') return 'recent';
  if (type === 'curation_rerate') return 'rerate';
  return null;
}

export function curationAnnouncementKind(flow: CurationFlowId | null | undefined): 'NEW' | 'RERATE' {
  return flow === 'rerate' ? 'RERATE' : 'NEW';
}

export function isCurationDiscordVoteCard(options: {
  curationRerateNum?: string | null;
  discordMessageUrl?: string | null;
  discordThreadClosed?: boolean | null;
} = {}): boolean {
  if (options.discordThreadClosed) return false;
  if (String(options.discordMessageUrl ?? '').trim()) return true;
  return /^\s*vote\b/i.test(String(options.curationRerateNum ?? ''));
}

/** SQL predicate matching {@link isCurationDiscordVoteCard} for list/zen filters. */
export function curationDiscordVoteSqlPredicate(
  ratingAlias = 'CurationRating',
  levelAlias = 'level',
): string {
  return `(
    (
      IFNULL(${ratingAlias}.discordThreadClosed, 0) = 0
      AND NULLIF(TRIM(${ratingAlias}.discordMessageUrl), '') IS NOT NULL
    )
    OR IFNULL(\`${levelAlias}\`.\`curationRerateNum\`, '') REGEXP '^[[:space:]]*vote([[:space:]]|$)'
  )`;
}

export function curationDiscordVoteWhereSql(
  vote: 'only' | 'exclude',
  ratingAlias = 'CurationRating',
  levelAlias = 'level',
): string {
  const predicate = curationDiscordVoteSqlPredicate(ratingAlias, levelAlias);
  return vote === 'only' ? predicate : `NOT ${predicate}`;
}

/** Fields persisted on every Elasticsearch level document for the curation queue. */
export function curationFieldsForLevelIndex(level: {
  toCuration?: unknown;
  curationFlow?: unknown;
  curationRerateNum?: unknown;
  curationRerateReason?: unknown;
}): {
  toCuration: boolean;
  curationFlow: CurationFlowId | null;
  curationRerateNum: string | null;
  curationRerateReason: string | null;
} {
  return {
    toCuration: level.toCuration === true,
    curationFlow: parseCurationFlow(level.curationFlow),
    curationRerateNum:
      level.curationRerateNum == null ? null : String(level.curationRerateNum),
    curationRerateReason:
      level.curationRerateReason == null ? null : String(level.curationRerateReason),
  };
}
