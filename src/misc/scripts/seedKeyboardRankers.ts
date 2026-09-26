/**
 * Seed matched ADOFAI keybind rankers onto TUF players.
 *
 *   cd server && npx tsx src/misc/scripts/seedKeyboardRankers.ts
 *   cd server && npm run seed:keyboard-rankers -- --apply
 */
import dotenv from 'dotenv';
dotenv.config();

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getSequelizeForModelGroup} from '@/config/db.js';
import {initializeAssociations} from '@/models/associations.js';
import Player from '@/models/players/Player.js';
import PlayerAlias from '@/models/players/PlayerAlias.js';
import User from '@/models/auth/User.js';
import {
  KeyboardGeometry,
  KeyboardLane,
  KeyboardLanePeriod,
  KeyboardBoardPeriod,
  KeyboardRig,
} from '@/models/keyboards/index.js';
import {canonicalizeKeys, keySignature, matchRankerToPlayer} from '@/misc/utils/keyboards/index.js';
import {appendKeyboardsModule} from '@/misc/utils/keyboards/appendModule.js';
import {
  getPieceForEntity,
  upsertPieceForEntity,
  ProfileCustomizationError,
} from '@/server/services/profileCustomization/ProfileCustomizationService.js';
import {logger} from '@/server/services/core/LoggerService.js';

initializeAssociations();

const MODE_SLUG: Record<string, string> = {
  full: 'full-108',
  tkl: 'tkl-80',
  '96': 'corsair-vanguard-pro-96',
  '75': 'niz-plum-84',
  '65': 'kemove-k68',
};

function argFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('-') ? value : undefined;
}

function defaultRankersPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../adofai-keybinds-handoff-2026-09-23-en/data/rankers.json');
}

async function main() {
  const apply = argFlag('--apply');
  const filePath = path.resolve(argValue('--file') || defaultRankersPath());
  const sequelize = getSequelizeForModelGroup('players');
  await sequelize.authenticate();

  const raw = await readFile(filePath, 'utf8');
  const rankers = JSON.parse(raw) as Array<{
    nameEn?: string | null;
    nameKo?: string | null;
    keyboardMode?: string;
    variants?: Array<{keyCount: number; keys: string[]}>;
  }>;
  if (!Array.isArray(rankers)) {
    throw new Error(`Expected JSON array in ${filePath}`);
  }

  const players = await Player.findAll({
    attributes: ['id', 'name'],
    include: [{model: PlayerAlias, as: 'playerAliases', attributes: ['name']}],
  });
  const named = players.map((player) => ({
    id: player.id,
    name: player.name,
    aliases: ((player as Player & {playerAliases?: PlayerAlias[]}).playerAliases ?? []).map(
      (alias) => alias.name,
    ),
  }));

  const geometries = await KeyboardGeometry.findAll();
  const geometryBySlug = new Map(geometries.map((row) => [row.slug, row]));

  const summary = {matched: 0, skippedNone: 0, skippedAmbiguous: 0, alreadyHadRig: 0, moduleOn: 0, moduleCap: 0, moduleNoUser: 0};

  for (const ranker of rankers) {
    const match = matchRankerToPlayer([ranker.nameEn, ranker.nameKo], named);
    if ('status' in match) {
      if (match.status === 'none') summary.skippedNone += 1;
      else summary.skippedAmbiguous += 1;
      logger.info(`skip ${ranker.nameEn || ranker.nameKo}: ${match.status}`);
      continue;
    }
    summary.matched += 1;
    const existing = await KeyboardRig.count({where: {playerId: match.playerId}});
    if (existing > 0) {
      summary.alreadyHadRig += 1;
      logger.info(`player ${match.playerId} already has a rig; skip data insert`);
    } else if (apply) {
      const slug = MODE_SLUG[ranker.keyboardMode || 'full'] || MODE_SLUG.full;
      const geometry = geometryBySlug.get(slug);
      if (!geometry) throw new Error(`Missing geometry ${slug}`);
      const productName = ranker.nameEn || ranker.nameKo || `Player ${match.playerId}`;
      await sequelize.transaction(async (transaction) => {
        const rig = await KeyboardRig.create(
          {playerId: match.playerId, name: productName, sortOrder: 0},
          {transaction},
        );
        await KeyboardBoardPeriod.create(
          {
            rigId: rig.id,
            sinceDate: null,
            isGap: false,
            geometryId: geometry.id,
            customModel: geometry.name,
          },
          {transaction},
        );
        for (const variant of ranker.variants ?? []) {
          const keys = canonicalizeKeys(variant.keys ?? []);
          const lane = await KeyboardLane.create(
            {rigId: rig.id, keyCount: variant.keyCount, name: `${variant.keyCount}K`},
            {transaction},
          );
          await KeyboardLanePeriod.create(
            {
              laneId: lane.id,
              sinceDate: null,
              keysJson: keys,
              keySignature: keySignature(keys),
            },
            {transaction},
          );
        }
      });
    }

    const user = await User.findOne({where: {playerId: match.playerId}, attributes: ['id']});
    if (!user) {
      summary.moduleNoUser += 1;
      continue;
    }
    const piece = await getPieceForEntity('player', match.playerId, 'profile_modules');
    const next = appendKeyboardsModule(piece?.payload ?? null, false);
    if (next.skippedReason === 'cap') {
      summary.moduleCap += 1;
      continue;
    }
    if (next.appended) {
      summary.moduleOn += 1;
      if (apply) {
        try {
          await upsertPieceForEntity(
            'player',
            match.playerId,
            'profile_modules',
            next.document as unknown as Record<string, unknown>,
          );
        } catch (error) {
          if (error instanceof ProfileCustomizationError) {
            logger.info(`module skip player ${match.playerId}: ${error.message}`);
            summary.moduleNoUser += 1;
            summary.moduleOn -= 1;
          } else {
            throw error;
          }
        }
      }
    }
  }

  logger.info(JSON.stringify({apply, filePath, ...summary}));
  process.exit(0);
}

main().catch((error) => {
  logger.error('seedKeyboardRankers failed', error);
  process.exit(1);
});
