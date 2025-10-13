#!/usr/bin/env tsx
import process from 'process';

// Load DB and models
import sequelize from '../config/db.js';
import Level from '../models/levels/Level.js';
import Difficulty from '../models/levels/Difficulty.js';
import LevelRerateHistory from '../models/levels/LevelRerateHistory.js';

async function main() {
  // Parse positional arguments
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: migrateDifficulties <fromIds> <toName>');
    console.error('Example: migrateDifficulties 41,42,43,44 Q0');
    process.exit(1);
  }
  const fromIds = args[0].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  const toName = args[1].trim();

  if (!fromIds.length) {
    console.error('No valid source diffIds provided.');
    process.exit(1);
  }
  if (!toName) {
    console.error('No target difficulty name provided.');
    process.exit(1);
  }

  await sequelize.authenticate();

  // Find target difficulty
  const targetDiff = await Difficulty.findOne({ where: { name: toName } });
  if (!targetDiff) {
    console.error(`Target difficulty '${toName}' not found.`);
    process.exit(1);
  }

  // Find all levels with source diffIds
  const levels = await Level.findAll({ where: { diffId: fromIds, clears: 0 } });
  if (!levels.length) {
    console.log('No levels found for the given diffIds.');
    process.exit(0);
  }

  // Find previous difficulties for rerate history
  const prevDiffs = await Difficulty.findAll({ where: { id: fromIds } });
  const prevDiffMap = new Map(prevDiffs.map(d => [d.id, d]));

  // Migrate levels and add rerate history
  let updated = 0;
  for (const level of levels) {
    const prevDiff = prevDiffMap.get(level.diffId);
    const previousBaseScore = level.baseScore || prevDiff?.baseScore || 0;
    const newBaseScore = level.baseScore || targetDiff.baseScore || 0;

    await LevelRerateHistory.create({
      levelId: level.id,
      previousDiffId: level.diffId,
      newDiffId: targetDiff.id,
      previousBaseScore,
      newBaseScore,
      reratedBy: null, // Not run by a user
      createdAt: new Date(),
    });

    await level.update({ diffId: targetDiff.id });
    updated++;
  }

  console.log(`Migrated ${updated} level(s) from diffIds [${fromIds.join(', ')}] to '${toName}' (id=${targetDiff.id}).`);
  process.exit(0);
}

main().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
