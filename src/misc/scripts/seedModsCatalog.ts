/**
 * One-shot seed of the public mods catalog from the Discord dump JSON.
 *
 *   cd server && npx tsx src/misc/scripts/seedModsCatalog.ts
 *   cd server && npm run seed:mods -- --file /path/to/sample
 *
 * Exits without inserting if `mods` already has rows.
 */
import dotenv from 'dotenv';
dotenv.config();

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getSequelizeForModelGroup} from '@/config/db.js';
import Mod from '@/models/misc/Mod.js';
import {mergeModSeedRows, toModCreateAttributes} from '@/server/services/mods/modSeed.js';
import {createCatalogMod} from '@/server/services/mods/modCreate.js';
import {logger} from '@/server/services/core/LoggerService.js';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('-') ? value : undefined;
}

function defaultSamplePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../sample');
}

async function main() {
  const filePath = path.resolve(argValue('--file') || defaultSamplePath());
  const sequelize = getSequelizeForModelGroup('admin');
  await sequelize.authenticate();

  const existing = await Mod.count();
  if (existing > 0) {
    logger.info(`mods catalog already has ${existing} rows; skipping seed`);
    process.exit(0);
  }

  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array in ${filePath}`);
  }

  const merged = mergeModSeedRows(parsed);
  if (!merged.length) {
    throw new Error(`No usable mod rows in ${filePath}`);
  }

  for (const row of merged) {
    await createCatalogMod(toModCreateAttributes(row));
  }
  logger.info(`seeded ${merged.length} mods from ${filePath} (${parsed.length} source rows)`);
  process.exit(0);
}

main().catch((error) => {
  logger.error('seedModsCatalog failed', error);
  process.exit(1);
});
