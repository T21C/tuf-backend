import { Command } from 'commander';
import cdnService from '../services/CdnService.js';
import Level from '../models/levels/Level.js';
import LevelTag from '../models/levels/LevelTag.js';
import LevelTagAssignment from '../models/levels/LevelTagAssignment.js';

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

const miscTagsMap = {
    containsDLC: "DLC",
    YouTubeStream: "Youtube Stream",
    KeyLimiter: "Key Limiter",
    Hold: "Hold",
    MultiPlanet: "Multi Planet",
    FreeRoam: "Free Roam",
    isJudgementLimited: "Judgement Limit",
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

/**
 * Get or create a tag by name
 */
async function getOrCreateTag(tagName: string): Promise<LevelTag> {
    let tag = await LevelTag.findOne({ where: { name: tagName } });
    if (!tag) {
        // Tag doesn't exist, create it with a random color
        const randomColor = generateRandomColor();
        console.log(`  Creating new tag "${tagName}" with color ${randomColor}`);
        tag = await LevelTag.create({
            name: tagName,
            color: randomColor
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
async function assignTagToLevel(levelId: number, tagName: string): Promise<boolean> {
    const tag = await getOrCreateTag(tagName);
    
    const alreadyAssigned = await isTagAssigned(levelId, tag.id);
    if (alreadyAssigned) {
        console.log(`  Tag "${tagName}" already assigned, skipping`);
        return false;
    }
    
    await LevelTagAssignment.create({
        levelId,
        tagId: tag.id
    });
    console.log(`  ✓ Assigned tag: "${tagName}"`);
    return true;
}

/**
 * Get level data from CDN service
 */
async function getLevelData(levelId: string) {
    const level = await Level.findByPk(levelId);
    if (!level) {
        console.error('Level not found');
        return null;
    }
    if (!level.dlLink) {
        console.error('Level does not have a dlLink');
        return null;
    }
    const levelData = await cdnService.getLevelData(level, ['settings', 'analysis']);
    return { level, levelData };
}

/**
 * Determine tags to assign based on analysis data
 * This function can be extended with more complex conditionals
 */
function determineTagsToAssign(analysis: any, settings: any): string[] {
    const tagsToAssign: string[] = [];
    
    // DLC tag
    if (analysis?.containsDLC) {
        tagsToAssign.push(miscTagsMap.containsDLC);
    }
    
    // VFX tier tags
    if (analysis?.vfxTier !== undefined) {
        const vfxTier = analysis.vfxTier as keyof typeof vfxTierTags;
        if (vfxTierTags[vfxTier]) {
            tagsToAssign.push(vfxTierTags[vfxTier]);
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
                tagsToAssign.push(lengthTagsMinutes[tagKey]);
                break;
            }
        }
    }
    
    // Judgement Limit tag
    if (analysis?.isJudgementLimited) {
        tagsToAssign.push(miscTagsMap.isJudgementLimited);
    }
    
    if (analysis?.requiredMods) {
        for (const mod of analysis.requiredMods as string[]) {
            if (miscTagsMap[mod as keyof typeof miscTagsMap]) {
                tagsToAssign.push(miscTagsMap[mod as keyof typeof miscTagsMap]);
            }
        }
    }

    if (analysis?.dlcEvents) {
        for (const event of analysis.dlcEvents as string[]) {
            if (miscTagsMap[event as keyof typeof miscTagsMap]) {
                tagsToAssign.push(miscTagsMap[event as keyof typeof miscTagsMap]);
            }
        }
    }



    // Can Decorations Kill tag (if needed - not in miscTagsMap currently)
    // if (analysis?.canDecorationsKill) {
    //     tagsToAssign.push("Decorations Kill");
    // }
    
    return tagsToAssign;
}

/**
 * Auto-assign tags to a level based on its analysis data
 */
async function autoAssignTags(levelId: string): Promise<void> {
    console.log(`\nAuto-assigning tags for level ${levelId}...`);
    
    const result = await getLevelData(levelId);
    if (!result) {
        return;
    }
    
    const { level, levelData } = result;
    const { analysis, settings } = levelData;
    
    if (!analysis) {
        console.error('No analysis data available for this level');
        return;
    }
    
    console.log('Analysis data:', JSON.stringify(analysis, null, 2));
    
    // Determine which tags should be assigned
    const tagsToAssign = determineTagsToAssign(analysis, settings);
    
    if (tagsToAssign.length === 0) {
        console.log('No tags to assign based on current analysis data');
        return;
    }
    
    console.log(`\nTags to assign: ${tagsToAssign.join(', ')}`);
    console.log('\nAssigning tags:');
    
    // Assign each tag
    let assignedCount = 0;
    for (const tagName of tagsToAssign) {
        try {
            const assigned = await assignTagToLevel(level.id, tagName);
            if (assigned) {
                assignedCount++;
            }
        } catch (error) {
            console.error(`  ✗ Failed to assign tag "${tagName}":`, error instanceof Error ? error.message : error);
        }
    }
    
    console.log(`\n✓ Successfully assigned ${assignedCount} tag(s)`);
}

const program = new Command();

program.command('autoAssignTags')
  .description('Auto assign tags to levels based on analysis data')
  .option('-l, --levelId <levelId>', 'Level ID to assign tags to', '1')
  .action(async (options) => {
    try {
      await autoAssignTags(options.levelId);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
    process.exit(0);
  });

program.parse(process.argv);