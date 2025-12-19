import { Command } from 'commander';
import cdnService from '../services/CdnService.js';
import Level from '../models/levels/Level.js';
import LevelTag from '../models/levels/LevelTag.js';
import LevelTagAssignment from '../models/levels/LevelTagAssignment.js';
import { logger } from '../services/LoggerService.js';
import dotenv from 'dotenv';
dotenv.config();

// Tag mapping configurations
const lengthTagsMinutes = {
    0: "Tiny",
    0.5: "30s",
    1: "1+ Minute",
    2: "2+ Minutes",
    3: "3+ Minutes",
    5: "5+ Minutes",
    7: "7+ Minutes",
    10: "10+ Minutes",
    15: "15+ Minutes",
    20: "20+ Minutes",
    30: "30+ Minutes",
    45: "45+ Minutes",
    60: "1+ Hours",
    90: "1.5+ Hours",
    120: "2+ Hours",
    360: "Desert Bus"
}

const vfxTierTags = {
    0: "Non-VFX",
    1: "Filters",
    2: "Decorations",
    3: "Full VFX",
}

const dlcTagsMap = {
    containsDLC: "DLC",
    Hold: "Hold",
    MultiPlanet: "Multi Planet",
    FreeRoam: "Free Roam",
}

const requiredModsTagsMap = {
    YouTubeStream: "Youtube Stream",
    KeyLimiter: "Key Limiter",
}

const miscTagsMap = {
    isJudgementLimited: "Judgement Limit",
}

const groupNameMap = {
    dlc: "DLC",
    requiredMods: "Required Mods",
    misc: "Misc",
    length: "Length",
    vfxTier: "VFX Tier"
}

/**
 * Generate a random hex color
 */
function generateRandomColor(): string {
    // Generate a random color with good contrast (avoid too light colors)
    const hue = Math.floor(Math.random() * 360);
    const saturation = Math.floor(Math.random() * 40) + 50; // 50-90% saturation
    const lightness = Math.floor(Math.random() * 30) + 40; // 40-70% lightness
    
    // Convert HSL to RGB then to hex
    const h = hue / 360;
    const s = saturation / 100;
    const l = lightness / 100;
    
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h * 6) % 2 - 1));
    const m = l - c / 2;
    
    let r = 0, g = 0, b = 0;
    if (h < 1/6) {
        r = c; g = x; b = 0;
    } else if (h < 2/6) {
        r = x; g = c; b = 0;
    } else if (h < 3/6) {
        r = 0; g = c; b = x;
    } else if (h < 4/6) {
        r = 0; g = x; b = c;
    } else if (h < 5/6) {
        r = x; g = 0; b = c;
    } else {
        r = c; g = 0; b = x;
    }
    
    r = Math.round((r + m) * 255);
    g = Math.round((g + m) * 255);
    b = Math.round((b + m) * 255);
    
    return `#${[r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')}`;
}

interface TagInfo {
    tagName: string;
    groupName: string;
}

/**
 * Get or create a tag by name
 */
async function getOrCreateTag(tagName: string, groupName?: string): Promise<LevelTag> {
    let tag = await LevelTag.findOne({ where: { name: tagName } });
    if (!tag) {
        // Tag doesn't exist, create it with a random color and group
        const randomColor = generateRandomColor();
        logger.debug(`  Creating new tag "${tagName}" with color ${randomColor}${groupName ? ` in group "${groupName}"` : ''}`);
        tag = await LevelTag.create({
            name: tagName,
            color: randomColor,
            group: groupName
        });
    }
    return tag;
}

/**
 * Check if a tag is already assigned to a level
 */
async function isTagAssigned(levelId: number, tagId: number): Promise<boolean> {
    const assignment = await LevelTagAssignment.findOne({
        where: { levelId, tagId }
    });
    return !!assignment;
}

/**
 * Assign a tag to a level if not already assigned
 */
async function assignTagToLevel(levelId: number, tagInfo: TagInfo): Promise<boolean> {
    const { tagName, groupName } = tagInfo;
    const tag = await getOrCreateTag(tagName, groupName);
    
    const alreadyAssigned = await isTagAssigned(levelId, tag.id);
    if (alreadyAssigned) {
        logger.debug(`  Tag "${tagName}" already assigned, skipping`);
        return false;
    }
    
    await LevelTagAssignment.create({
        levelId,
        tagId: tag.id
    });
    logger.debug(`  ✓ Assigned tag: "${tagName}"`);
    return true;
}

/**
 * Get level data from CDN service
 */
async function getLevelData(levelId: string) {
    const level = await Level.findByPk(levelId);
    if (!level) {
        logger.error('Level not found');
        return null;
    }
    if (!level.dlLink) {
        logger.error('Level does not have a dlLink');
        return null;
    }
    const levelData = await cdnService.getLevelData(level, ['settings', 'analysis']);
    return { level, levelData };
}

/**
 * Determine tags to assign based on analysis data
 * This function can be extended with more complex conditionals
 */
function determineTagsToAssign(analysis: any, settings: any): TagInfo[] {
    const tagsToAssign: TagInfo[] = [];
    
    // DLC tag (from dlcTagsMap)
    if (analysis?.containsDLC) {
        tagsToAssign.push({ tagName: dlcTagsMap.containsDLC, groupName: groupNameMap.dlc });
    }
    
    // VFX tier tags
    if (analysis?.vfxTier !== undefined) {
        const vfxTier = analysis.vfxTier as keyof typeof vfxTierTags;
        if (vfxTierTags[vfxTier]) {
            tagsToAssign.push({ tagName: vfxTierTags[vfxTier], groupName: groupNameMap.vfxTier });
        }
    }
    
    // Length tags (based on levelLengthInMs)
    if (analysis?.levelLengthInMs !== undefined) {
        const lengthInMinutes = analysis.levelLengthInMs / 1000 / 60;
        // Find the appropriate length tag (use the largest threshold that applies)
        const lengthThresholds = Object.keys(lengthTagsMinutes)
            .map(Number)
            .sort((a, b) => b - a); // Sort descending
        
        for (const threshold of lengthThresholds) {
            if (lengthInMinutes >= threshold) {
                const tagKey = threshold as keyof typeof lengthTagsMinutes;
                tagsToAssign.push({ tagName: lengthTagsMinutes[tagKey], groupName: groupNameMap.length });
                break;
            }
        }
    }
    
    // Judgement Limit tag (from miscTagsMap)
    if (analysis?.isJudgementLimited) {
        tagsToAssign.push({ tagName: miscTagsMap.isJudgementLimited, groupName: groupNameMap.misc });
    }
    
    // Required mods tags
    if (analysis?.requiredMods) {
        for (const mod of analysis.requiredMods as string[]) {
            if (requiredModsTagsMap[mod as keyof typeof requiredModsTagsMap]) {
                tagsToAssign.push({ tagName: requiredModsTagsMap[mod as keyof typeof requiredModsTagsMap], groupName: groupNameMap.requiredMods });
            }
        }
    }

    // DLC events tags (from dlcTagsMap)
    if (analysis?.dlcEvents) {
        for (const event of analysis.dlcEvents as string[]) {
            if (dlcTagsMap[event as keyof typeof dlcTagsMap]) {
                tagsToAssign.push({ tagName: dlcTagsMap[event as keyof typeof dlcTagsMap], groupName: groupNameMap.dlc });
            }
        }
    }



    // Can Decorations Kill tag (if needed - not in miscTagsMap currently)
    // if (analysis?.canDecorationsKill) {
    //     tagsToAssign.push({ tagName: "Decorations Kill", groupName: groupNameMap.misc });
    // }
    
    return tagsToAssign;
}

/**
 * Auto-assign tags to a level based on its analysis data
 */
async function autoAssignTags(levelId: string): Promise<void> {
    logger.debug(`Auto-assigning tags for level ${levelId}...`);
    
    const result = await getLevelData(levelId);
    if (!result) {
        return;
    }
    
    const { level, levelData } = result;
    const { analysis, settings } = levelData;
    
    if (!analysis) {
        logger.error('No analysis data available for this level');
        return;
    }
    
    logger.debug('Analysis data:', JSON.stringify(analysis, null, 2));
    
    // Determine which tags should be assigned
    const tagsToAssign = determineTagsToAssign(analysis, settings);
    
    if (tagsToAssign.length === 0) {
        logger.debug('No tags to assign based on current analysis data');
        return;
    }
    
    logger.debug(`Tags to assign: ${tagsToAssign.map(t => `${t.tagName} (${t.groupName})`).join(', ')}`);
    logger.debug('Assigning tags:');
    
    // Assign each tag
    let assignedCount = 0;
    for (const tagInfo of tagsToAssign) {
        try {
            const assigned = await assignTagToLevel(level.id, tagInfo);
            if (assigned) {
                assignedCount++;
            }
        } catch (error) {
            logger.error(`  ✗ Failed to assign tag "${tagInfo.tagName}":`, error instanceof Error ? error.message : error);
        }
    }
    
    if (assignedCount > 0) {
        logger.info(`  ✓ Successfully assigned ${assignedCount} tag(s) to level ${levelId}`);
    } else {
        logger.info(`  ✗ No tags assigned to level ${levelId}`);
    }
}

const program = new Command();

program.command('testAssign')
  .description('Auto assign tags to levels based on analysis data')
  .option('-l, --levelId <levelId>', 'Level ID to assign tags to', '1')
  .action(async (options) => {
    try {
      await autoAssignTags(options.levelId);
    } catch (error) {
      logger.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
    process.exit(0);
  });

program.command('autoAssignTags')
  .description('Auto assign tags to levels based on analysis data')
  .option('-o, --offset <offset>', 'Offset to start from', '0')
  .option('-l, --limit <limit>', 'Limit to process', '100')
  .option('-b, --batch-size <batchSize>', 'Batch size to process', '50')
  .action(async (options) => {
    try {
        const offset = parseInt(options.offset) || 0;
        const limit = parseInt(options.limit) || 100;
        const batchSize = parseInt(options.batchSize) || 50;
        const totalBatches = Math.ceil(limit / batchSize);
        let batchNumber = 0;

        for (let i = offset; i < offset + limit; i += batchSize) {
            batchNumber++;
            const levelIds = await Level.findAll({
                attributes: ['id'],
                offset: i,
                limit: Math.min(batchSize, offset + limit - i)
            });
            const promises = levelIds.map(level => autoAssignTags(level.id.toString()));
            await Promise.all(promises);
            logger.info(`Processed batch ${batchNumber} of ${totalBatches}`);
        }
    } catch (error) {
      logger.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      process.exit(0);
    }
  });

program.parse(process.argv);