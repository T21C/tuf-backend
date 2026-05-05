/**
 * Backfill player_leaderboard_rank_events by diffing consecutive UTC end-of-day snapshots.
 *
 * Usage:
 *   npx tsx src/misc/scripts/backfillLeaderboardRankHistory.ts --from 2020-01-01 --to 2026-05-01
 *   --scoring-version 2026-01-es-parity-v1 --overwrite --dry-run --resume
 *
 * Flags:
 *   --from YYYY-MM-DD   (required unless inferred from DB min pass date)
 *   --to YYYY-MM-DD     (required; inclusive)
 *   --scoring-version   (default from config)
 *   --overwrite         DELETE existing rows for each day in range before re-inserting
 *   --dry-run           Log counts only; no DB writes
 *   --resume            Start from checkpoint+1 or max(--from, checkpoint+1)
 */
import dotenv from 'dotenv';
dotenv.config();

import sequelize from '@/config/db.js';
import db from '@/models/index.js';
import { DEFAULT_LEADERBOARD_RANK_SCORING_VERSION } from '@/config/leaderboardRankHistory.js';
import { LeaderboardRankSnapshotService } from '@/server/services/leaderboard/LeaderboardRankSnapshotService.js';
import { iterateUtcDateOnlyRange, utcNextIsoDateOnly } from '@/server/services/leaderboard/leaderboardRankSnapshotUtils.js';
import { QueryTypes } from 'sequelize';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function inferMinPassDay(): Promise<string> {
  const rows = (await sequelize.query(
    `SELECT DATE(MIN(p.vidUploadTime)) AS d FROM passes p WHERE p.isDeleted = false`,
    { type: QueryTypes.SELECT },
  )) as { d: string | Date }[];
  const raw = rows?.[0]?.d;
  if (!raw) return '2020-01-01';
  if (raw instanceof Date) {
    const y = raw.getUTCFullYear();
    const m = String(raw.getUTCMonth() + 1).padStart(2, '0');
    const d = String(raw.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(raw).slice(0, 10);
}

async function main(): Promise<void> {
  const scoringVersion = argValue('--scoring-version') ?? DEFAULT_LEADERBOARD_RANK_SCORING_VERSION;
  let from = argValue('--from');
  const to = argValue('--to');
  const overwrite = hasFlag('--overwrite');
  const dryRun = hasFlag('--dry-run');
  const resume = hasFlag('--resume');

  if (!to) {
    console.error('Missing required --to YYYY-MM-DD');
    process.exit(1);
  }

  if (!from) {
    from = await inferMinPassDay();
    console.log(`Inferred --from ${from} from MIN(vidUploadTime)`);
  }

  await db.sequelize.authenticate();

  let start = from;
  if (resume) {
    const cp = await LeaderboardRankSnapshotService.readCheckpoint(scoringVersion);
    if (cp) {
      const next = utcNextIsoDateOnly(cp);
      if (next > start) {
        console.log(`Resume: checkpoint last=${cp}, starting at ${next}`);
        start = next;
      }
    }
  }

  if (start > to) {
    console.log('Nothing to do (start > end).');
    process.exit(0);
  }

  let totalDelta = 0;
  for (const day of iterateUtcDateOnlyRange(start, to)) {
    try {
      if (dryRun) {
        const r = await LeaderboardRankSnapshotService.processSingleEffectiveDay({
          scoringVersion,
          effectiveDay: day,
          overwrite: false,
          dryRun: true,
        });
        console.log(`${day}: dry-run deltaRows=${r.deltaRows}`);
        continue;
      }

      const r = await LeaderboardRankSnapshotService.processSingleEffectiveDay({
        scoringVersion,
        effectiveDay: day,
        overwrite,
        dryRun: false,
      });
      totalDelta += r.deltaRows;
      console.log(`${day}: deltaRows=${r.deltaRows} skipped=${r.skipped}`);
    } catch (e) {
      console.error(`Failed on ${day}:`, e);
      process.exit(1);
    }
  }

  console.log(JSON.stringify({ ok: true, scoringVersion, from: start, to, totalDeltaRows: totalDelta, dryRun }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
