import cdnService from './CdnService.js';
import Level from '../models/levels/Level.js';
import LevelTag from '../models/levels/LevelTag.js';
import LevelTagAssignment from '../models/levels/LevelTagAssignment.js';
import { logger } from './LoggerService.js';
import { Op } from 'sequelize';

// Tag mapping configurations
const lengthTagsMinutes: Record<number, string> = {
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
};

const vfxTierTags: Record<number, string> = {
    0: "Non-VFX",
    1: "Filters",
    2: "Decorations",
    3: "Full VFX",
};

const dlcTagsMap: Record<string, string> = {
    containsDLC: "DLC",
    Hold: "Hold",
    MultiPlanet: "Multi Planet",
    FreeRoam: "Free Roam",
};

const requiredModsTagsMap: Record<string, string> = {
    YouTubeStream: "Youtube Stream",
    KeyLimiter: "Key Limiter",
};

const miscTagsMap: Record<string, string> = {
    isJudgementLimited: "Judgement Limit",
};

const groupNameMap = {
    dlc: "DLC",
    requiredMods: "Required Mods",
    misc: "Misc",
    length: "Length",
    vfxTier: "VFX Tier"
} as const;

export interface TagInfo {
    tagName: string;
    groupName: string;
}

export interface AutoTagResult {
    levelId: number;
    assignedTags: string[];
    removedTags: string[];
    errors: string[];
}

/**
 * Service for managing automatic tag assignment to levels
 */
class TagAssignmentService {
    private static instance: TagAssignmentService;

    private constructor() {}

    public static getInstance(): TagAssignmentService {
        if (!TagAssignmentService.instance) {
            TagAssignmentService.instance = new TagAssignmentService();
        }
        return TagAssignmentService.instance;
    }

    /**
     * Get all tag names that can be auto-assigned
     */
    public getAutoTagNames(): string[] {
        const allAutoTags: string[] = [
            ...Object.values(lengthTagsMinutes),
            ...Object.values(vfxTierTags),
            ...Object.values(dlcTagsMap),
            ...Object.values(requiredModsTagsMap),
            ...Object.values(miscTagsMap),
        ];
        return [...new Set(allAutoTags)]; // Remove duplicates
    }

    /**
     * Get all group names for auto-assigned tags
     */
    public getAutoTagGroups(): string[] {
        return Object.values(groupNameMap);
    }

    /**
     * Generate a random hex color for new tags
     */
    private generateRandomColor(): string {
        const hue = Math.floor(Math.random() * 360);
        const saturation = Math.floor(Math.random() * 40) + 50; // 50-90% saturation
        const lightness = Math.floor(Math.random() * 30) + 40; // 40-70% lightness
        
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
    private async getOrCreateTag(tagName: string, groupName?: string): Promise<LevelTag> {
        let tag = await LevelTag.findOne({ where: { name: tagName } });
        if (!tag) {
            const randomColor = this.generateRandomColor();
            logger.debug(`Creating new tag "${tagName}" with color ${randomColor}${groupName ? ` in group "${groupName}"` : ''}`);
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
    private async isTagAssigned(levelId: number, tagId: number): Promise<boolean> {
        const assignment = await LevelTagAssignment.findOne({
            where: { levelId, tagId }
        });
        return !!assignment;
    }

    /**
     * Assign a single tag to a level if not already assigned
     */
    private async assignTagToLevel(levelId: number, tagInfo: TagInfo): Promise<boolean> {
        const { tagName, groupName } = tagInfo;
        const tag = await this.getOrCreateTag(tagName, groupName);
        
        const alreadyAssigned = await this.isTagAssigned(levelId, tag.id);
        if (alreadyAssigned) {
            logger.debug(`Tag "${tagName}" already assigned to level ${levelId}, skipping`);
            return false;
        }
        
        await LevelTagAssignment.create({
            levelId,
            tagId: tag.id
        });
        logger.debug(`Assigned tag "${tagName}" to level ${levelId}`);
        return true;
    }

    /**
     * Get level data from CDN service for analysis
     */
    private async getLevelAnalysis(level: Level): Promise<{ analysis: any; settings: any } | null> {
        if (!level.dlLink) {
            logger.debug(`Level ${level.id} does not have a dlLink`);
            return null;
        }
        
        try {
            const levelData = await cdnService.getLevelData(level, ['settings', 'analysis']);
            return levelData;
        } catch (error) {
            logger.error(`Failed to get level data for level ${level.id}:`, error instanceof Error ? error.message : error);
            return null;
        }
    }

    /**
     * Determine which tags should be assigned based on analysis data
     */
    public determineTagsFromAnalysis(analysis: any, settings: any): TagInfo[] {
        const tagsToAssign: TagInfo[] = [];
        
        // DLC tag
        if (analysis?.containsDLC) {
            tagsToAssign.push({ tagName: dlcTagsMap.containsDLC, groupName: groupNameMap.dlc });
        }
        
        // VFX tier tags
        if (analysis?.vfxTier !== undefined) {
            const vfxTier = analysis.vfxTier as number;
            if (vfxTierTags[vfxTier]) {
                tagsToAssign.push({ tagName: vfxTierTags[vfxTier], groupName: groupNameMap.vfxTier });
            }
        }
        
        // Length tags (based on levelLengthInMs)
        if (analysis?.levelLengthInMs !== undefined) {
            const lengthInMinutes = analysis.levelLengthInMs / 1000 / 60;
            const lengthThresholds = Object.keys(lengthTagsMinutes)
                .map(Number)
                .sort((a, b) => b - a); // Sort descending
            
            for (const threshold of lengthThresholds) {
                if (lengthInMinutes >= threshold) {
                    tagsToAssign.push({ tagName: lengthTagsMinutes[threshold], groupName: groupNameMap.length });
                    break;
                }
            }
        }
        
        // Judgement Limit tag
        if (analysis?.isJudgementLimited) {
            tagsToAssign.push({ tagName: miscTagsMap.isJudgementLimited, groupName: groupNameMap.misc });
        }
        
        // Required mods tags
        if (analysis?.requiredMods) {
            for (const mod of analysis.requiredMods as string[]) {
                if (requiredModsTagsMap[mod]) {
                    tagsToAssign.push({ tagName: requiredModsTagsMap[mod], groupName: groupNameMap.requiredMods });
                }
            }
        }

        // DLC events tags
        if (analysis?.dlcEvents) {
            for (const event of analysis.dlcEvents as string[]) {
                if (dlcTagsMap[event]) {
                    tagsToAssign.push({ tagName: dlcTagsMap[event], groupName: groupNameMap.dlc });
                }
            }
        }
        
        return tagsToAssign;
    }

    /**
     * Remove all auto-assigned tags from a level
     * Only removes tags that are in the auto-assignable groups
     */
    public async removeAutoTags(levelId: number): Promise<string[]> {
        const autoTagNames = this.getAutoTagNames();
        
        // Find all auto-assignable tags that are currently assigned to this level
        const autoTags = await LevelTag.findAll({
            where: {
                name: { [Op.in]: autoTagNames }
            }
        });
        
        if (autoTags.length === 0) {
            return [];
        }
        
        const autoTagIds = autoTags.map(tag => tag.id);
        
        // Find assignments for this level with auto tags
        const assignments = await LevelTagAssignment.findAll({
            where: {
                levelId,
                tagId: { [Op.in]: autoTagIds }
            },
            include: [{
                model: LevelTag,
                as: 'tag'
            }]
        });
        
        const removedTagNames: string[] = [];
        
        for (const assignment of assignments) {
            const tagName = (assignment as any).tag?.name;
            await assignment.destroy();
            if (tagName) {
                removedTagNames.push(tagName);
            }
        }
        
        if (removedTagNames.length > 0) {
            logger.debug(`Removed ${removedTagNames.length} auto-assigned tags from level ${levelId}: ${removedTagNames.join(', ')}`);
        }
        
        return removedTagNames;
    }

    /**
     * Auto-assign tags to a level based on its analysis data
     */
    public async assignAutoTags(levelId: number): Promise<AutoTagResult> {
        const result: AutoTagResult = {
            levelId,
            assignedTags: [],
            removedTags: [],
            errors: []
        };
        
        const level = await Level.findByPk(levelId);
        if (!level) {
            result.errors.push(`Level ${levelId} not found`);
            return result;
        }
        
        const levelData = await this.getLevelAnalysis(level);
        if (!levelData) {
            result.errors.push(`No analysis data available for level ${levelId}`);
            return result;
        }
        
        const { analysis, settings } = levelData;
        
        if (!analysis) {
            result.errors.push(`No analysis data in response for level ${levelId}`);
            return result;
        }
        
        const tagsToAssign = this.determineTagsFromAnalysis(analysis, settings);
        
        if (tagsToAssign.length === 0) {
            logger.debug(`No tags to assign for level ${levelId}`);
            return result;
        }
        
        logger.debug(`Tags to assign for level ${levelId}: ${tagsToAssign.map(t => `${t.tagName} (${t.groupName})`).join(', ')}`);
        
        for (const tagInfo of tagsToAssign) {
            try {
                const assigned = await this.assignTagToLevel(levelId, tagInfo);
                if (assigned) {
                    result.assignedTags.push(tagInfo.tagName);
                }
            } catch (error) {
                const errorMsg = `Failed to assign tag "${tagInfo.tagName}": ${error instanceof Error ? error.message : error}`;
                result.errors.push(errorMsg);
                logger.error(errorMsg);
            }
        }
        
        if (result.assignedTags.length > 0) {
            logger.info(`Assigned ${result.assignedTags.length} tag(s) to level ${levelId}: ${result.assignedTags.join(', ')}`);
        }
        
        return result;
    }

    /**
     * Get currently assigned auto tags for a level
     */
    private async getCurrentAutoTags(levelId: number): Promise<string[]> {
        const autoTagNames = this.getAutoTagNames();
        
        const autoTags = await LevelTag.findAll({
            where: {
                name: { [Op.in]: autoTagNames }
            }
        });
        
        if (autoTags.length === 0) {
            return [];
        }
        
        const autoTagIds = autoTags.map(tag => tag.id);
        
        const assignments = await LevelTagAssignment.findAll({
            where: {
                levelId,
                tagId: { [Op.in]: autoTagIds }
            },
            include: [{
                model: LevelTag,
                as: 'tag'
            }]
        });
        
        return assignments
            .map(a => (a as any).tag?.name)
            .filter((name): name is string => !!name);
    }

    /**
     * Refresh auto-assigned tags for a level (smart delta - only changes what's different)
     */
    public async refreshAutoTags(levelId: number): Promise<AutoTagResult> {
        const result: AutoTagResult = {
            levelId,
            assignedTags: [],
            removedTags: [],
            errors: []
        };
        
        try {
            const level = await Level.findByPk(levelId);
            if (!level) {
                result.errors.push(`Level ${levelId} not found`);
                return result;
            }
            
            // Get current auto tags on the level
            const currentAutoTags = await this.getCurrentAutoTags(levelId);
            const currentTagSet = new Set(currentAutoTags);
            
            // Determine what tags should be assigned based on analysis
            const levelData = await this.getLevelAnalysis(level);
            if (!levelData) {
                result.errors.push(`No analysis data available for level ${levelId}`);
                return result;
            }
            
            const { analysis, settings } = levelData;
            if (!analysis) {
                result.errors.push(`No analysis data in response for level ${levelId}`);
                return result;
            }
            
            const desiredTags = this.determineTagsFromAnalysis(analysis, settings);
            const desiredTagNames = desiredTags.map(t => t.tagName);
            const desiredTagSet = new Set(desiredTagNames);
            
            // Calculate delta: what to remove and what to add
            const tagsToRemove = currentAutoTags.filter(tag => !desiredTagSet.has(tag));
            const tagsToAdd = desiredTags.filter(t => !currentTagSet.has(t.tagName));
            
            // Remove tags that shouldn't be there anymore
            if (tagsToRemove.length > 0) {
                const autoTags = await LevelTag.findAll({
                    where: {
                        name: { [Op.in]: tagsToRemove }
                    }
                });
                const tagIdsToRemove = autoTags.map(tag => tag.id);
                
                await LevelTagAssignment.destroy({
                    where: {
                        levelId,
                        tagId: { [Op.in]: tagIdsToRemove }
                    }
                });
                
                result.removedTags = tagsToRemove;
                logger.debug(`Removed tags from level ${levelId}: ${tagsToRemove.join(', ')}`);
            }
            
            // Add tags that should be there
            for (const tagInfo of tagsToAdd) {
                try {
                    const tag = await this.getOrCreateTag(tagInfo.tagName, tagInfo.groupName);
                    await LevelTagAssignment.create({
                        levelId,
                        tagId: tag.id
                    });
                    result.assignedTags.push(tagInfo.tagName);
                } catch (error) {
                    const errorMsg = `Failed to assign tag "${tagInfo.tagName}": ${error instanceof Error ? error.message : error}`;
                    result.errors.push(errorMsg);
                    logger.error(errorMsg);
                }
            }
            
            if (result.removedTags.length > 0 || result.assignedTags.length > 0) {
                logger.info(`Refreshed auto tags for level ${levelId}: removed [${result.removedTags.join(', ')}], added [${result.assignedTags.join(', ')}]`);
            } else {
                logger.debug(`No auto tag changes needed for level ${levelId}`);
            }
        } catch (error) {
            result.errors.push(`Failed to refresh auto tags: ${error instanceof Error ? error.message : error}`);
            logger.error(`Error refreshing auto tags for level ${levelId}:`, error);
        }
        
        return result;
    }
}

export const tagAssignmentService = TagAssignmentService.getInstance();
export default TagAssignmentService;
