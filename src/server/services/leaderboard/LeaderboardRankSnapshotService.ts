import { Transaction } from 'sequelize';
import sequelize from '@/config/db.js';
import { DEFAULT_LEADERBOARD_RANK_SCORING_VERSION } from '@/config/leaderboardRankHistory.js';
import PlayerLeaderboardRankEvent from '@/models/players/PlayerLeaderboardRankEvent.js';
import { logger } from '@/server/services/core/LoggerService.js';
import {
  diffRankSnapshots,
  fetchHistoricalLeaderboardRanksAtCutoff,
  rowsToRankMap,
} from '@/server/services/leaderboard/historicalPlayerStatsAtCutoff.js';
import {
  utcEndOfIsoDateOnly,
  utcPreviousIsoDateOnly,
  utcDateOnlyFromDate,
} from '@/server/services/leaderboard/leaderboardRankSnapshotUtils.js';

export class LeaderboardRankSnapshotService {
  static async dayAlreadyWritten(scoringVersion: string, effectiveDay: string): Promise<boolean> {
    const row = await PlayerLeaderboardRankEvent.findOne({
      where: { scoringVersion, effectiveDay },
      attributes: ['id'],
    });
    return row != null;
  }

  static async deleteEventsForDay(
    scoringVersion: string,
    effectiveDay: string,
    transaction?: Transaction,
  ): Promise<number> {
    return PlayerLeaderboardRankEvent.destroy({
      where: { scoringVersion, effectiveDay },
      transaction,
    });
  }

  static async updateCheckpoint(scoringVersion: string, lastDay: string): Promise<void> {
    await sequelize.query(
      `INSERT INTO leaderboard_rank_backfill_checkpoint (scoringVersion, lastCompletedEffectiveDay, updatedAt)
       VALUES (:scoringVersion, :lastDay, NOW())
       ON DUPLICATE KEY UPDATE lastCompletedEffectiveDay = VALUES(lastCompletedEffectiveDay), updatedAt = NOW()`,
      { replacements: { scoringVersion, lastDay } },
    );
  }

  static async readCheckpoint(scoringVersion: string): Promise<string | null> {
    const [rows] = (await sequelize.query(
      `SELECT lastCompletedEffectiveDay FROM leaderboard_rank_backfill_checkpoint WHERE scoringVersion = :scoringVersion LIMIT 1`,
      { replacements: { scoringVersion } },
    )) as [{ lastCompletedEffectiveDay: string | null }[], unknown];
    const v = rows?.[0]?.lastCompletedEffectiveDay;
    return v ? String(v).slice(0, 10) : null;
  }

  /**
   * Process one calendar day: diff end(prevDay) vs end(effectiveDay), persist with effectiveDay label.
   */
  static async processSingleEffectiveDay(options: {
    scoringVersion: string;
    effectiveDay: string;
    overwrite: boolean;
    dryRun: boolean;
  }): Promise<{ deltaRows: number; skipped: boolean }> {
    if (!options.overwrite && !options.dryRun && (await this.dayAlreadyWritten(options.scoringVersion, options.effectiveDay))) {
      await this.updateCheckpoint(options.scoringVersion, options.effectiveDay);
      return { deltaRows: 0, skipped: true };
    }

    const prevDay = utcPreviousIsoDateOnly(options.effectiveDay);
    const prevCutoff = utcEndOfIsoDateOnly(prevDay);
    const currCutoff = utcEndOfIsoDateOnly(options.effectiveDay);

    const [prevRows, currRows] = await Promise.all([
      fetchHistoricalLeaderboardRanksAtCutoff(prevCutoff),
      fetchHistoricalLeaderboardRanksAtCutoff(currCutoff),
    ]);
    const prevMap = rowsToRankMap(prevRows);
    const currMap = rowsToRankMap(currRows);
    const deltas = diffRankSnapshots(prevMap, currMap);

    if (options.dryRun) {
      logger.info(`[LeaderboardRankSnapshot] dry-run ${options.effectiveDay}: ${deltas.length} delta rows`);
      return { deltaRows: deltas.length, skipped: false };
    }

    const t = await sequelize.transaction();
    try {
      if (options.overwrite) {
        await this.deleteEventsForDay(options.scoringVersion, options.effectiveDay, t);
      }

      if (deltas.length > 0) {
        await PlayerLeaderboardRankEvent.bulkCreate(
          deltas.map((d) => ({
            playerId: d.playerId,
            scoringVersion: options.scoringVersion,
            effectiveDay: options.effectiveDay,
            rankedScoreRank: d.rankedScoreRank,
            generalScoreRank: d.generalScoreRank,
          })),
          { transaction: t },
        );
      }

      await this.updateCheckpoint(options.scoringVersion, options.effectiveDay);
      await t.commit();
      return { deltaRows: deltas.length, skipped: false };
    } catch (e) {
      await t.rollback();
      throw e;
    }
  }

  /**
   * Daily cron: closed **yesterday** (UTC). Skips if rows already exist unless `force`.
   */
  static async runYesterdaySnapshot(options?: {
    scoringVersion?: string;
    force?: boolean;
  }): Promise<{ skipped: boolean; effectiveDay: string; deltaRows: number }> {
    const scoringVersion = options?.scoringVersion ?? DEFAULT_LEADERBOARD_RANK_SCORING_VERSION;
    const today = utcDateOnlyFromDate(new Date());
    const yesterday = utcPreviousIsoDateOnly(today);

    if (!options?.force && (await this.dayAlreadyWritten(scoringVersion, yesterday))) {
      logger.info(`[LeaderboardRankSnapshot] skip ${yesterday} (already written)`);
      return { skipped: true, effectiveDay: yesterday, deltaRows: 0 };
    }

    const r = await this.processSingleEffectiveDay({
      scoringVersion,
      effectiveDay: yesterday,
      overwrite: Boolean(options?.force),
      dryRun: false,
    });
    logger.info(`[LeaderboardRankSnapshot] wrote ${yesterday}: ${r.deltaRows} delta rows (skipped=${r.skipped})`);
    return { skipped: r.skipped, effectiveDay: yesterday, deltaRows: r.deltaRows };
  }
}

export { utcDateOnlyFromDate };
