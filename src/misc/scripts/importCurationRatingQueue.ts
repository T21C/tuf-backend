/**
 * One-time import of the curation rating queue from the Discord recent list
 * (inlined below) and the sheet Bulk column. Does not publish tiers or copy
 * curator votes.
 *
 * Intended to run inside the API container, which already has DB/ES env:
 *
 *   docker compose --env-file /srv/tuf/config/stack.env -f compose.yml exec api \
 *     node dist/misc/scripts/importCurationRatingQueue.js
 *   docker compose --env-file /srv/tuf/config/stack.env -f compose.yml exec api \
 *     node dist/misc/scripts/importCurationRatingQueue.js --apply
 *
 * Dry-run locally (needs the same env the API uses):
 *   npx tsx src/misc/scripts/importCurationRatingQueue.ts
 */

import dotenv from 'dotenv';
import {Command} from 'commander';
import {type Transaction} from 'sequelize';
import sequelize from '@/config/db.js';
import {initializeAssociations} from '@/models/associations.js';
import Level from '@/models/levels/Level.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {safeTransactionRollback, sanitizeTextInput} from '@/misc/utils/Utility.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import {
  parseCurationSheetCsv,
  parseRecentIdList,
  selectCurationImportTargets,
  type CurationImportTarget,
} from '@/misc/utils/data/curationRatingImport.js';
import {
  ensureOpenCurationRating,
  openLevelOnCurationPage,
} from '@/server/services/curations/openCurationRatingService.js';

dotenv.config();

/** Discord recent-list ids; overlap with Bulk stays Recent. */
const RECENT_LEVEL_IDS =
  '16296,14168,703,15195,16332,16353,15472,15006,16366,12039,12044,14825,16344,16364,8588,14759,14999,15267,15562,16381,14615,16361,15168,16383,15100,10827,15943,14801,15391,15441,15130,8590,16400,16389,4025,6656,7101,13950,16404,16416,10987,16028,6291,7463,11736,16309,16429,16089,16084,15710,15021,12597,10924,10855,10681,9933,16441,16442,15721,15214,4500,14330,16452,16102,5074,16469,16444,16445,16446,16486,13632,16517,16511,16512,16318,16513,16514,16515,16516,16518,16519,7423,7456,1559,10821,1884,16435,16437,11667,16307,13638,4603,1412,16500,12310,14616,13628,14905,16193,16347,9804,16531,515,1786,16544,16551,7610,16359,16562,16561,16505,352,1427,16567,14232,16099,13162,2309,16535,16536,16537,16538,290,16502,16583,16585,16607,12900,16617,13631,13065,3218,16256,14912,13429,13031,11356,11275,15840,15897,16627,16623,14301,2651,16643,16644,16645,16646,16647,16648,16649,16650,16651,16652,16653,16654,16655,16660,15362,16503,16671,16637,16684,16688,16710,11655,16298,10323,16720,16721,2395,3866,12581,3085,16685,16510,10021,11528,16621,16629,16639,16729,16780,16783,7829,15099,1799,7252,7960,16368,16798,16718,16715,16814,16837,11676,14962,16207,16878,16888,16891,8372,7298,2515,1686,7568,6000,6002,7780,6528,12291,897,9877,3718,3716,10556,8446,16378,16826,11271,16786,16785,5155,11547,10639,9464,16945,16964,16962,1655,16980,7848,12281,16939,16940,16225,16924,16802,16991,3096,5839,17068,10696,17097,5736,984,14762,12303,17137,17146,17147,10950,7343,16936,16935,627,7301,4266,4078,4079,4081,4267,4268,17086,418,17169,1391,9020,9559,16883,16029,12726,15304,15305,15306,15708,15709,15711,16086,16087,16088,16090,16091,17108,17109,15435,12707,12262,15369,12719,11813,12047,8050,11531,8961,15628,786,791,784,1217,1218,10972,10238,14820,10279,15547,6527,4270,32,12380,13003,15317,17020,16810,1647,12570,12605,17049,17093,17042,17043,15072,16542,16543,17064,13325,15310,8429,17281,10824,16403,16142,15221,9981,11623,17110,11836,12517,11918,15601,8150,13805,17209,17005,16013,7681,16818,17185,17238,16899,17195,15995,15670,11735,12279,17246,9160,13892,10929,17297,16998,16782,3606,12376,14226,14185,10071,16026,8683,8685,15735,9050,14092,16582,11160,10543,17000,17157,13960,16219,16889,17407,10573,10033,16949,16915,16895,17450,17451,17452,17453,17454,17455,17456,17457,17458,13542,15420,14672,15459,12673,12308,14706,11121,15055,13361,12397,8863,11559,12773,11930,13205,12423,10091,11116,4861,11079,2715,14668,14669,6348,11020,12662,13571,14704,12037,11540,15069,15028,6427,14670,11165,11852,14705,6195,12915,15035,11909,15036,12733,11019,15034,12413,5617,8697,12506,12354,14725,13037,14676,13282,15461,8803,13591,15037,14677,14679,12776,14678,14368,14680,15038,12829,14726,15029,12901,14673,15590,14681,14683,13759,15052,12760,14684,17836,14682,12779,15070,15031,15032,15027,12774,14685,14686,13091,12798,14687,13290,14667,12909,14655,14688,14689,14690,13057,13072,14497,13000,14675,14498,13001,14671,13616,14664,14660,14369,14666,14711,15588,14665,14659,14656,13359,13291,13225,14658,13276,13323,14663,13317,14657,14662,15589,15371,15367,15366,15318,15368,15361,15370,15257,15786,15617,15787,16172,15609,15607,15456,16034,17609,17610,17611,17612,17613,16254,17614,17615,17616,17617,17621,17622,17623,17755';

const DEFAULT_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1VXzmrPRAcPWEm5IwRKpKnhX9LqAP81e76BJhEgZ-HMU/export?format=csv&gid=1079465913';
const DEFAULT_BATCH_SIZE = 200;

initializeAssociations();

function chunkIds<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function readSheetCsv(sheetUrl: string): Promise<string> {
  if (!/^https?:\/\//i.test(sheetUrl)) {
    throw new Error(`Sheet must be an http(s) URL (got ${sheetUrl})`);
  }
  const response = await fetch(sheetUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch sheet CSV: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function applyTarget(
  target: CurationImportTarget,
  transaction: Transaction,
): Promise<'opened' | 'updated' | 'missing' | 'deleted' | 'hidden'> {
  const level = await Level.findByPk(target.levelId, {
    attributes: ['id', 'toCuration', 'isDeleted', 'isHidden', 'curationRerateReason', 'curationFlow'],
    transaction,
    lock: true,
  });
  if (!level) return 'missing';
  if (level.isDeleted) return 'deleted';
  if (level.isHidden) return 'hidden';

  const reason = target.reason.trim();
  if (level.toCuration) {
    await ensureOpenCurationRating(target.levelId, transaction);
    await level.update(
      {
        curationFlow: target.flow,
        ...(reason ? {curationRerateReason: sanitizeTextInput(reason)} : {}),
      },
      {transaction},
    );
    return 'updated';
  }

  await openLevelOnCurationPage(target.levelId, {
    flow: target.flow,
    reason: reason || null,
    transaction,
  });
  return 'opened';
}

async function run(options: {
  sheet: string;
  apply: boolean;
  skipEsIndex: boolean;
  batchSize: number;
}): Promise<void> {
  const recentIds = parseRecentIdList(RECENT_LEVEL_IDS);
  const sheetCsv = await readSheetCsv(options.sheet);
  const sheetRows = parseCurationSheetCsv(sheetCsv);
  const {targets, skippedNoId, skippedDone} = selectCurationImportTargets({recentIds, sheetRows});

  const recentSet = new Set(recentIds);
  const bulkTargets = targets.filter((row) => row.flow === 'bulk');
  const overlapBulk = sheetRows.filter(
    (row) => row.levelId != null && row.bulk && recentSet.has(row.levelId),
  );
  const uniqueOverlap = new Set(overlapBulk.map((row) => row.levelId));

  logger.info(
    `Recent ids: ${recentIds.length} unique. Sheet rows: ${sheetRows.length}. Targets: ${targets.length} (recent ${targets.filter((row) => row.flow === 'recent').length}, bulk ${bulkTargets.length}). Overlap kept on Recent: ${uniqueOverlap.size}. Skipped no id: ${skippedNoId}. Skipped done bulk: ${skippedDone}.`,
  );

  const counts = {
    opened: 0,
    updated: 0,
    missing: 0,
    deleted: 0,
    hidden: 0,
  };

  if (!options.apply) {
    logger.info('Dry run: no database changes. Pass --apply to write the queue.');
    return;
  }

  const touchedIds: number[] = [];
  for (const chunk of chunkIds(targets, options.batchSize)) {
    const transaction = await sequelize.transaction();
    try {
      for (const target of chunk) {
        const outcome = await applyTarget(target, transaction);
        counts[outcome] += 1;
        if (outcome === 'opened' || outcome === 'updated') {
          touchedIds.push(target.levelId);
        }
      }
      await transaction.commit();
    } catch (error) {
      await safeTransactionRollback(transaction);
      throw error;
    }
    await yieldEventLoop();
  }

  logger.info(
    `Opened ${counts.opened}, updated ${counts.updated}, missing ${counts.missing}, deleted ${counts.deleted}, hidden ${counts.hidden}.`,
  );

  if (options.skipEsIndex || touchedIds.length === 0) {
    if (options.skipEsIndex) logger.info('Skipped Elasticsearch reindex (--skip-es-index)');
    return;
  }

  try {
    const es = ElasticsearchService.getInstance();
    const idChunks = chunkIds(touchedIds, options.batchSize);
    for (let i = 0; i < idChunks.length; i++) {
      const chunk = idChunks[i];
      await es.reindexLevels(chunk);
      logger.info(`Elasticsearch reindex chunk ${i + 1}/${idChunks.length} (${chunk.length} levels)`);
      await yieldEventLoop();
    }
  } catch (error) {
    logger.warn(
      'Elasticsearch reindex failed (queue rows are committed):',
      error instanceof Error ? error.message : error,
    );
  }
}

const program = new Command();
program
  .name('importCurationRatingQueue')
  .description(
    'Open the curation rating queue from the inlined recent ids plus sheet Bulk=TRUE rows. Overlap stays Recent. Does not publish types or enqueue announcements. Run from the API container.',
  )
  .option('--sheet <url>', 'Sheet CSV Google export URL', DEFAULT_SHEET_URL)
  .option('--apply', 'Write the queue (default is dry-run)', false)
  .option('--skip-es-index', 'Do not reindex touched levels after apply', false)
  .option(
    '--batch-size <n>',
    `Commit and reindex batch size (default: ${DEFAULT_BATCH_SIZE})`,
    (value) => parseInt(value, 10),
    DEFAULT_BATCH_SIZE,
  )
  .action(async (opts) => {
    try {
      const batchSize = Number(opts.batchSize);
      if (!Number.isFinite(batchSize) || batchSize < 1) {
        throw new Error(`Invalid --batch-size: ${opts.batchSize}`);
      }
      await run({
        sheet: opts.sheet,
        apply: Boolean(opts.apply),
        skipEsIndex: Boolean(opts.skipEsIndex),
        batchSize,
      });
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    process.exit(0);
  });

program.parse(process.argv);
