/**
 * Sync level curations from a checklist CSV.
 *
 * WARNING: Deleting a Curation CASCADE-deletes CurationSchedule rows for that curation.
 * WARNING: This script bypasses HTTP API rules (e.g. FORCE_DESCRIPTION on some types).
 *
 * Usage:
 *   npx tsx src/misc/scripts/applyLevelCurationChecklist.ts --assigned-by <user-uuid> [--csv path] [--dry-run] [--skip-missing-levels] [--skip-es-index] [--batch-size N]
 *
 * assigned-by can be set via CURATION_CHECKLIST_ASSIGNED_BY instead of --assigned-by.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Command } from 'commander';
import { Op } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { initializeAssociations } from '@/models/associations.js';
import Curation from '@/models/curations/Curation.js';
import CurationCurationType from '@/models/curations/CurationCurationType.js';
import CurationType from '@/models/curations/CurationType.js';
import Level from '@/models/levels/Level.js';
import User from '@/models/auth/User.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV = path.join(__dirname, 'level curation checklist.csv');

/** Chunk size for DB IN-queries, per-row yields in the apply loop, and ES reindex ID batches (avoids huge single queries / OOM). */
const DEFAULT_BATCH_SIZE = 200;

const curSequelize = getSequelizeForModelGroup('curations');

function chunkIds<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error('batch size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function stripBom(s: string): string {
  if (s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}

/** Minimal CSV line parser (handles quotes). */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && c === ',') {
      result.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  result.push(cur.trim());
  return result;
}

interface CsvRow {
  levelId: number;
  typeNames: string[];
  lineNumber: number;
}

function normalizeHeaderCell(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseChecklistCsv(filePath: string): CsvRow[] {
  const raw = stripBom(fs.readFileSync(filePath, 'utf8'));
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error('CSV must have a header row and at least one data row');
  }

  const headerCells = parseCsvLine(lines[0]).map(normalizeHeaderCell);
  const idxTuf = headerCells.findIndex((h) => h === 'tuf id' || h === 'tufid');
  const idxChart = headerCells.findIndex((h) => h === 'chart');
  const idxVfx = headerCells.findIndex((h) => h === 'vfx');
  const idxMisc = headerCells.findIndex((h) => h === 'misc');
  if (idxTuf < 0 || idxChart < 0 || idxVfx < 0 || idxMisc < 0) {
    throw new Error(
      `CSV header must include columns: TUF ID, Chart, VFX, Misc. Got: ${headerCells.join(' | ')}`
    );
  }

  const rows: CsvRow[] = [];
  const seenLevelIds = new Map<number, number>();

  for (let i = 1; i < lines.length; i++) {
    const lineNumber = i + 1;
    const cells = parseCsvLine(lines[i]);
    const tufStr = cells[idxTuf]?.trim() ?? '';
    if (!tufStr) continue;
    const levelId = parseInt(tufStr, 10);
    if (!Number.isFinite(levelId) || levelId <= 0) {
      throw new Error(`Line ${lineNumber}: invalid TUF ID "${tufStr}"`);
    }
    if (seenLevelIds.has(levelId)) {
      throw new Error(
        `Duplicate TUF ID ${levelId} (first at line ${seenLevelIds.get(levelId)}, duplicate at line ${lineNumber})`
      );
    }
    seenLevelIds.set(levelId, lineNumber);

    const typeNames: string[] = [];
    const slots = [idxChart, idxVfx, idxMisc];
    for (const idx of slots) {
      const v = cells[idx]?.trim() ?? '';
      if (v) typeNames.push(v);
    }

    rows.push({ levelId, typeNames, lineNumber });
  }

  return rows;
}

function dedupeTypeNamesToIds(
  names: string[],
  nameToId: Map<string, number>
): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const name of names) {
    const id = nameToId.get(name);
    if (id === undefined) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function run(options: {
  csv: string;
  assignedBy: string | undefined;
  dryRun: boolean;
  skipMissingLevels: boolean;
  skipEsIndex: boolean;
  batchSize: number;
}): Promise<void> {
  initializeAssociations();

  const assignedBy =
    options.assignedBy?.trim() || process.env.CURATION_CHECKLIST_ASSIGNED_BY?.trim();
  if (!options.dryRun && !assignedBy) {
    throw new Error(
      'Missing assigned-by: pass --assigned-by <uuid> or set CURATION_CHECKLIST_ASSIGNED_BY (required when not using --dry-run)'
    );
  }

  if (!options.dryRun && assignedBy) {
    const user = await User.findByPk(assignedBy);
    if (!user) {
      throw new Error(`No user found for assigned-by UUID: ${assignedBy}`);
    }
  }

  const rows = parseChecklistCsv(options.csv);
  const csvLevelIds = rows.map((r) => r.levelId);

  const allTypeNames = new Set<string>();
  for (const r of rows) {
    for (const n of r.typeNames) allTypeNames.add(n);
  }

  const types = await CurationType.findAll({
    where: { name: [...allTypeNames] },
    attributes: ['id', 'name'],
  });
  const nameToId = new Map(types.map((t) => [t.name, t.id]));
  const missingNames = [...allTypeNames].filter((n) => !nameToId.has(n));
  if (missingNames.length > 0) {
    throw new Error(
      `Unknown curation type name(s) (not in database): ${missingNames.sort().join(', ')}`
    );
  }

  const batchSize = options.batchSize;
  const existingSet = new Set<number>();
  for (const idChunk of chunkIds(csvLevelIds, batchSize)) {
    const chunkRows = await Level.findAll({
      where: { id: { [Op.in]: idChunk } },
      attributes: ['id'],
    });
    for (const l of chunkRows) existingSet.add(l.id);
    await yieldEventLoop();
  }
  const missingLevels = csvLevelIds.filter((id) => !existingSet.has(id));

  if (missingLevels.length > 0 && !options.skipMissingLevels) {
    throw new Error(
      `Level ID(s) not found in database: ${missingLevels.sort((a, b) => a - b).join(', ')}. Use --skip-missing-levels to skip those rows.`
    );
  }

  const rowsToApply = options.skipMissingLevels
    ? rows.filter((r) => existingSet.has(r.levelId))
    : rows;

  logger.info(
    `Parsed ${rows.length} CSV row(s), ${allTypeNames.size} distinct type name(s), applying ${rowsToApply.length} row(s)`
  );

  if (options.dryRun) {
    logger.info('Dry run: validation passed, no database changes.');
    return;
  }

  const levelIdsForEs = new Set<number>([...csvLevelIds]);
  const csvLevelIdSet = new Set(csvLevelIds);

  const transaction = await curSequelize.transaction();
  try {
    const deletedJunction = await CurationCurationType.destroy({
      where: {},
      transaction,
    });
    logger.info(`Removed ${deletedJunction} curation_curation_types row(s)`);

    let rowIndex = 0;
    for (const row of rowsToApply) {
      const typeIds = dedupeTypeNamesToIds(row.typeNames, nameToId);

      if (typeIds.length === 0) {
        const destroyed = await Curation.destroy({
          where: { levelId: row.levelId },
          transaction,
        });
        if (destroyed) {
          levelIdsForEs.add(row.levelId);
          logger.debug(`Removed empty curation for level ${row.levelId} (line ${row.lineNumber})`);
        }
        rowIndex++;
        if (rowIndex % batchSize === 0) await yieldEventLoop();
        continue;
      }

      let curation = await Curation.findOne({
        where: { levelId: row.levelId },
        transaction,
      });

      if (!curation) {
        curation = await Curation.create(
          {
            levelId: row.levelId,
            assignedBy: assignedBy!,
            shortDescription: '',
            description: null,
            previewLink: null,
            customCSS: null,
            customColor: null,
          },
          { transaction }
        );
      }

      await curation.update({assignedBy: assignedBy!, updatedAt: new Date()}, {transaction});
      await curation.setTypes(typeIds, { transaction });
      levelIdsForEs.add(row.levelId);
      rowIndex++;
      if (rowIndex % batchSize === 0) await yieldEventLoop();
    }

    let removedExtra = 0;
    let scanAfterId = 0;
    for (;;) {
      const scanBatch = await Curation.findAll({
        where: { id: { [Op.gt]: scanAfterId } },
        attributes: ['id', 'levelId'],
        order: [['id', 'ASC']],
        limit: batchSize,
        transaction,
      });
      if (scanBatch.length === 0) break;
      scanAfterId = scanBatch[scanBatch.length - 1].id;
      const idsToDelete: number[] = [];
      for (const c of scanBatch) {
        if (!csvLevelIdSet.has(c.levelId)) {
          idsToDelete.push(c.id);
          levelIdsForEs.add(c.levelId);
        }
      }
      if (idsToDelete.length > 0) {
        const n = await Curation.destroy({
          where: { id: { [Op.in]: idsToDelete } },
          transaction,
        });
        removedExtra += n;
      }
      await yieldEventLoop();
    }
    logger.info(`Removed ${removedExtra} curation(s) for levels not listed in CSV`);

    await transaction.commit();
    logger.info('Transaction committed.');
  } catch (e) {
    await safeTransactionRollback(transaction);
    throw e;
  }

  if (!options.skipEsIndex && levelIdsForEs.size > 0) {
    try {
      const es = ElasticsearchService.getInstance();
      const allIds = [...levelIdsForEs];
      const idChunks = chunkIds(allIds, batchSize);
      for (let c = 0; c < idChunks.length; c++) {
        const chunk = idChunks[c];
        await es.reindexLevels(chunk);
        logger.info(
          `Elasticsearch reindex chunk ${c + 1}/${idChunks.length} (${chunk.length} level(s), ${allIds.length} total)`
        );
        await yieldEventLoop();
      }
      logger.info(`Elasticsearch reindex finished for ${allIds.length} level(s)`);
    } catch (esErr) {
      logger.warn(
        'Elasticsearch reindex failed (data is committed):',
        esErr instanceof Error ? esErr.message : esErr
      );
    }
  } else if (options.skipEsIndex) {
    logger.info('Skipped Elasticsearch reindex (--skip-es-index)');
  }
}

const program = new Command();
program
  .name('applyLevelCurationChecklist')
  .description(
    'Apply level curation type assignments from CSV. Deletes all curation_curation_types rows first, ' +
      'then assigns types per row; removes curations for levels not in CSV or rows with no types. ' +
      'WARNING: deleting a curation removes its CurationSchedule rows (CASCADE).'
  )
  .option('--csv <path>', 'Path to checklist CSV', DEFAULT_CSV)
  .option(
    '--assigned-by <uuid>',
    'User UUID for assignedBy on newly created curations (or env CURATION_CHECKLIST_ASSIGNED_BY)'
  )
  .option('--dry-run', 'Validate CSV and types only; do not modify the database', false)
  .option(
    '--skip-missing-levels',
    'Skip CSV rows whose TUF ID is not a valid level id (default: fail if any missing)',
    false
  )
  .option('--skip-es-index', 'Do not call Elasticsearch reindex after commit', false)
  .option(
    '--batch-size <n>',
    `Batch size for DB id lookups, apply-loop yields, and ES reindex id chunks (default: ${DEFAULT_BATCH_SIZE})`,
    (v) => parseInt(v, 10),
    DEFAULT_BATCH_SIZE
  )
  .action(async (opts) => {
    try {
      const csvPath = path.resolve(opts.csv);
      if (!fs.existsSync(csvPath)) {
        throw new Error(`CSV file not found: ${csvPath}`);
      }
      const batchSize = Number(opts.batchSize);
      if (!Number.isFinite(batchSize) || batchSize < 1) {
        throw new Error(`Invalid --batch-size: ${opts.batchSize} (use a positive integer)`);
      }
      await run({
        csv: csvPath,
        assignedBy: opts.assignedBy,
        dryRun: Boolean(opts.dryRun),
        skipMissingLevels: Boolean(opts.skipMissingLevels),
        skipEsIndex: Boolean(opts.skipEsIndex),
        batchSize,
      });
    } catch (err) {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    process.exit(0);
  });

program.parse(process.argv);
