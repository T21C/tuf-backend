import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sequelize from '../config/db.js';
import LevelRerateHistory from '../models/levels/LevelRerateHistory.js';
import Difficulty from '../models/levels/Difficulty.js';
import Level from '../models/levels/Level.js';

interface LegacyRerate {
  date: string;
  id: number;
  old: string;
  new: string;
}

// Load the JSON file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const legacyRerates: LegacyRerate[] = JSON.parse(
  readFileSync(join(__dirname, 'legacyRerates.json'), 'utf-8')
);

async function restoreLegacyRerates() {
  try {
    console.log('Starting legacy rerates restoration...');
    console.log(`Total rerates to process: ${legacyRerates.length}`);

    // Fetch all difficulties once to avoid repeated queries
    const difficulties = await Difficulty.findAll();
    const difficultyMap = new Map<string, { id: number; baseScore: number }>();
    
    difficulties.forEach(diff => {
      difficultyMap.set(diff.name, {
        id: diff.id,
        baseScore: diff.baseScore
      });
    });

    console.log(`Loaded ${difficultyMap.size} difficulties`);

    // Fetch all level IDs to validate existence
    console.log('Fetching all level IDs...');
    const allLevels = await Level.findAll({ attributes: ['id'] });
    const levelIdSet = new Set(allLevels.map(l => l.id));
    console.log(`Loaded ${levelIdSet.size} level IDs`);

    let notFoundLevels: number[] = [];
    const rerateDataArray: any[] = [];

    // Collect all rerates
    for (const rerate of legacyRerates) {
      // Check if level exists
      if (!levelIdSet.has(rerate.id)) {
        notFoundLevels.push(rerate.id);
        continue;
      }

      // Try to find matching difficulties
      const oldDiff = difficultyMap.get(rerate.old);
      const newDiff = difficultyMap.get(rerate.new);

      // Prepare the rerate history entry
      rerateDataArray.push({
        levelId: rerate.id,
        previousDiffId: oldDiff?.id || null,
        newDiffId: newDiff?.id || null,
        oldLegacyValue: oldDiff ? null : rerate.old,
        newLegacyValue: newDiff ? null : rerate.new,
        reratedBy: "d610436c-08a0-43c7-87e0-f25fc44367ad", // v0w4n as rerater
        createdAt: new Date(rerate.date)
      });
    }

    console.log(`\nCollected ${rerateDataArray.length} rerates to insert`);
    console.log(`Skipped ${notFoundLevels.length} rerates (levels not found)`);

    // Bulk insert all rerates
    if (rerateDataArray.length > 0) {
      console.log('\nPerforming bulk insert...');
      await LevelRerateHistory.bulkCreate(rerateDataArray);
      console.log('Bulk insert completed successfully!');
    }

    console.log('\n=== Restoration Complete ===');
    console.log(`Successfully restored: ${rerateDataArray.length} rerates`);
    console.log(`Skipped: ${notFoundLevels.length}`);
    
    if (notFoundLevels.length > 0) {
      console.log(`\nLevels not found (${notFoundLevels.length}):`, notFoundLevels.slice(0, 20));
      if (notFoundLevels.length > 20) {
        console.log(`... and ${notFoundLevels.length - 20} more`);
      }
    }

  } catch (error) {
    console.error('Fatal error during restoration:', error);
    throw error;
  }
}

// Run the script
restoreLegacyRerates()
  .then(() => {
    console.log('\nScript completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nScript failed:', error);
    process.exit(1);
  });

