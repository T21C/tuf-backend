export const CURATION_FLOWS = ['recent', 'rerate', 'bulk'] as const;
export type CurationFlowId = (typeof CURATION_FLOWS)[number];

export function parseCurationFlow(value: unknown): CurationFlowId | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'recent' || text === 'rerate' || text === 'bulk') return text;
  return null;
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
