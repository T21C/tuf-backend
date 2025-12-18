import { Command } from 'commander';
import cdnService from '../services/CdnService.js';
import Level from '../models/levels/Level.js';

async function getLevelData(levelId: string) {
    const level = await Level.findByPk(levelId);
    if (!level) {
        console.error('Level not found');
        return;
    }
    if (!level.dlLink) {
        console.error('Level does not have a dlLink');
        return;
    }
    const levelData = await cdnService.getLevelData(level, ['analysis']);
    return levelData;
}

const program = new Command();

program.command('autoAssignTags')
  .description('Auto assign tags to levels')
  .option('-l, --levelId <levelId>', 'Level to get data from', '1')
  .action(async (options) => {
    console.log(await getLevelData(options.levelId));
    process.exit(0);
  });

program.parse(process.argv);