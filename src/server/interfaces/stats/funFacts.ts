/**
 * SQL-backed "fun facts" appended to v3 player/creator profile responses.
 * All numeric fields are always present (use 0 when not applicable).
 */

export interface PlayerFunFactsCounts {
  totalPasses: number;
  uniqueLevelsCleared: number;
  worldsFirstCount: number;
  worldsFirstPPCount: number;
  clears12K: number;
  clears16K: number;
  clearsNoHoldTap: number;
  /**
   * Passes flagged `isDuplicate` plus extra clears after the first on the same
   * level (same filters as other fun-fact pass aggregates).
   */
  duplicatePasses: number;
  hiddenPasses: number;
  /** Passes with stored accuracy exactly 1 (same eligibility as other fun-fact pass aggregates). */
  totalPurePerfectClears: number;
}

export interface PlayerFunFactsJudgements {
  totalTilesHit: number;
  earlyDouble: number;
  earlySingle: number;
  ePerfect: number;
  perfect: number;
  lPerfect: number;
  lateSingle: number;
  lateDouble: number;
  totalXacc: number;
  earlyVsLateBias: number;
}

export interface PlayerFunFactsLevelsCleared {
  totalTilecountCleared: number;
  totalPlaytimeMs: number;
  averageBpm: number;
  /** Sum of scoreV2 across every pass row (includes reclears). */
  totalRawScoreV2: number;
}

export interface PlayerFunFactsExtremes {
  firstPassAt: string | null;
  firstPassAtPassId?: number | null;
  latestPassAt: string | null;
  latestPassAtPassId?: number | null;
  bestAccuracy: number | null;
  bestAccuracyPassId?: number | null;
  worstAccuracy: number | null;
  worstAccuracyPassId?: number | null;
  topSpeed: number | null;
  topSpeedPassId?: number | null;
  highestTilecountCleared: number | null;
  highestTilecountClearedPassId?: number | null;
  longestLevelMs: number | null;
  longestLevelMsPassId?: number | null;
  highestBpmCleared: number | null;
  highestBpmClearedPassId?: number | null;
}

export interface PlayerFunFactsActivity {
  accountAgeDays: number;
  passesLast30Days: number;
  uniqueLevelsLiked: number;
  packsOwned: number;
  packsFavorited: number;
}

export interface PlayerFunFacts {
  counts: PlayerFunFactsCounts;
  judgements: PlayerFunFactsJudgements;
  levelsCleared: PlayerFunFactsLevelsCleared;
  extremes: PlayerFunFactsExtremes;
  activity: PlayerFunFactsActivity;
  /** diffId string -> clear count (every pass row, including replays on the same level) */
  clearsByDifficulty: Record<string, number>;
  /**
   * diffId string -> clear count with at most one pass per level counted
   * (the highest scoreV2 pass per levelId, same rule as ranked top-score picks).
   * Distinct from the `isDuplicate` column, which flags a different product case.
   */
  clearsByDifficultyNoDupes: Record<string, number>;
  /** diffId string -> number of world's-first passes on that difficulty */
  worldsFirstByDifficulty: Record<string, number>;
  /** diffId string -> number of world's-first perfect passes on that difficulty */
  worldsFirstPPByDifficulty: Record<string, number>;
  clearsByDifficultyType: {
    PGU: number;
    SPECIAL: number;
  };
}

export interface CreatorFunFactsIdentity {
  aliasCount: number;
  teamsJoined: number;
}

export interface CreatorFunFactsCredits {
  levelsCreditedDistinct: number;
  levelsAsCharter: number;
  levelsAsVfxer: number;
  levelsOnAssignedTeam: number;
  levelsOwned: number;
}

export interface CreatorFunFactsContent {
  totalTilesMade: number;
  totalLevelDurationMs: number;
  averageTilecount: number;
  averageLevelLengthMs: number;
  averageBpm: number;
  totalClearsOnLevels: number;
  totalLikesOnLevels: number;
  totalDownloadsOnLevels: number;
}

export interface CreatorFunFactsAudience {
  uniquePlayersCleared: number;
  worldsFirstsOnLevels: number;
  worldsFirstPPsOnLevels: number;
  totalTilesPlayedOnLevels: number;
}

export interface CreatorFunFactsCuration {
  /**
   * Distinct levels credited to this creator (charter/vfxer) that carry at least
   * one curation type row matching the same eligibility rules as profile
   * `curationTypeCounts` (C/O vs charter, V vs vfxer, H/other).
   */
  curatedLevels: number;
  rerateCount: number;
}

export interface CreatorFunFactsTimeline {
  firstLevelAt: string | null;
  latestLevelAt: string | null;
}

export interface CreatorFunFacts {
  identity: CreatorFunFactsIdentity;
  credits: CreatorFunFactsCredits;
  content: CreatorFunFactsContent;
  audience: CreatorFunFactsAudience;
  curation: CreatorFunFactsCuration;
  timeline: CreatorFunFactsTimeline;
  levelsByDifficulty: Record<string, number>;
  levelsByDifficultyType: {
    PGU: number;
    SPECIAL: number;
  };
}
