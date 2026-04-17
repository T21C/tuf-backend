/**
 * Adapter: converts a flat ES player document into the legacy PlayerStats-shaped
 * object that v2 clients (leaderboard, search) still expect.
 *
 * Legacy shape (roughly):
 * {
 *   id,                      // playerId
 *   rankedScore, generalScore, ppScore, wfScore, score12K,
 *   rankedScoreRank, generalScoreRank, ppScoreRank, wfScoreRank, score12KRank,
 *   averageXacc, universalPassCount, worldsFirstCount, totalPasses,
 *   topDiffId, top12kDiffId,
 *   topDiff, top12kDiff,
 *   rank,                    // alias of rankedScoreRank
 *   player: {
 *     id, name, country, pfp, isBanned,
 *     user: { id, username, nickname, avatarUrl, permissionFlags, ... }
 *   }
 * }
 */
export interface LegacyPlayerStatsShape {
  id: number;
  rankedScore: number;
  generalScore: number;
  ppScore: number;
  wfScore: number;
  score12K: number;
  averageXacc: number;
  universalPassCount: number;
  worldsFirstCount: number;
  totalPasses: number;
  topDiffId: number;
  top12kDiffId: number;
  topDiff: any;
  top12kDiff: any;
  rankedScoreRank?: number;
  generalScoreRank?: number;
  ppScoreRank?: number;
  wfScoreRank?: number;
  score12KRank?: number;
  rank?: number;
  player: {
    id: number;
    name: string;
    country: string | null;
    pfp: string | null;
    isBanned: boolean;
    user: any;
  };
}

export function esDocToLegacyPlayerStats(
  doc: any,
  ranks?: {
    rankedScoreRank?: number;
    generalScoreRank?: number;
    ppScoreRank?: number;
    wfScoreRank?: number;
    score12KRank?: number;
  },
): LegacyPlayerStatsShape {
  const safeDoc = doc ?? {};
  return {
    id: Number(safeDoc.id ?? 0),
    rankedScore: Number(safeDoc.rankedScore ?? 0),
    generalScore: Number(safeDoc.generalScore ?? 0),
    ppScore: Number(safeDoc.ppScore ?? 0),
    wfScore: Number(safeDoc.wfScore ?? 0),
    score12K: Number(safeDoc.score12K ?? 0),
    averageXacc: Number(safeDoc.averageXacc ?? 0),
    universalPassCount: Number(safeDoc.universalPassCount ?? 0),
    worldsFirstCount: Number(safeDoc.worldsFirstCount ?? 0),
    totalPasses: Number(safeDoc.totalPasses ?? 0),
    topDiffId: Number(safeDoc.topDiffId ?? 0),
    top12kDiffId: Number(safeDoc.top12kDiffId ?? 0),
    topDiff: safeDoc.topDiff ?? null,
    top12kDiff: safeDoc.top12kDiff ?? null,
    rankedScoreRank: ranks?.rankedScoreRank,
    generalScoreRank: ranks?.generalScoreRank,
    ppScoreRank: ranks?.ppScoreRank,
    wfScoreRank: ranks?.wfScoreRank,
    score12KRank: ranks?.score12KRank,
    rank: ranks?.rankedScoreRank,
    player: {
      id: Number(safeDoc.id ?? 0),
      name: safeDoc.name ?? '',
      country: safeDoc.country ?? null,
      pfp: safeDoc.pfp ?? null,
      isBanned: Boolean(safeDoc.isBanned),
      user: safeDoc.user ?? null,
    },
  };
}
