import Pass from '../../models/Pass.js';
import Level from '../../models/Level.js';
import AnnouncementDirective from '../../models/AnnouncementDirective.js';
import DirectiveConditionHistory from '../../models/DirectiveConditionHistory.js';
import {DirectiveCondition} from '../../interfaces/models/index.js';
import AnnouncementChannel from '../../models/AnnouncementChannel.js';
import AnnouncementRole from '../../models/AnnouncementRole.js';
import DirectiveAction from '../../models/DirectiveAction.js';
import { evaluateDirectiveCondition } from '../../utils/directiveParser.js';
import crypto from 'crypto';

interface AnnouncementConfig {
  webhooks: {
    [key: string]: string; // channel label -> webhook URL
  };
  pings: {
    [key: string]: string; // channel label -> ping content
  };
}



function evaluateCondition(condition: DirectiveCondition, pass: Pass, level: Level): boolean {
  if (!condition) return true;


  switch (condition.type) {
    case 'ACCURACY':
      if (!condition.value || !condition.operator) return false;
      const accuracy = pass.accuracy || 0;
      const targetAccuracy = Number(condition.value);
      
      const result = (() => {
        switch (condition.operator) {
          case 'EQUAL':
            return accuracy === targetAccuracy;
          case 'GREATER_THAN':
            return accuracy > targetAccuracy;
          case 'LESS_THAN':
            return accuracy < targetAccuracy;
          case 'GREATER_THAN_EQUAL':
            return accuracy >= targetAccuracy;
          case 'LESS_THAN_EQUAL':
            return accuracy <= targetAccuracy;
          default:
            return false;
        }
      })();


      return result;

    case 'WORLDS_FIRST':
      return pass.isWorldsFirst === true;

    case 'BASE_SCORE':
      if (!condition.value || !condition.operator || !level.baseScore) return false;
      const baseScore = level.baseScore;
      const targetScore = Number(condition.value);
      
      switch (condition.operator) {
        case 'EQUAL':
          return baseScore === targetScore;
        case 'GREATER_THAN':
          return baseScore > targetScore;
        case 'LESS_THAN':
          return baseScore < targetScore;
        case 'GREATER_THAN_EQUAL':
          return baseScore >= targetScore;
        case 'LESS_THAN_EQUAL':
          return baseScore <= targetScore;
        default:
          return false;
      }

    case 'CUSTOM':
      if (!condition.customFunction) return false;
      try {
        return evaluateDirectiveCondition(condition.customFunction, pass, level);
      } catch (error) {
        console.error('Error evaluating custom condition:', error);
        return false;
      }

    default:
      return false;
  }
}

function generateConditionHash(condition: DirectiveCondition, levelId: number): string {
  // Create a string representation of the condition and level ID
  const conditionString = JSON.stringify({
    ...condition,
    levelId, // Include level ID in the hash
  });
  // Generate a hash of the condition string
  return crypto.createHash('sha256').update(conditionString).digest('hex');
}

async function hasConditionBeenMetBefore(levelId: number, condition: DirectiveCondition): Promise<boolean> {
  const conditionHash = generateConditionHash(condition, levelId);
  const history = await DirectiveConditionHistory.findOne({
    where: {
      levelId,
      conditionHash,
    },
  });
  return !!history;
}

async function recordConditionMet(levelId: number, condition: DirectiveCondition): Promise<void> {
  const conditionHash = generateConditionHash(condition, levelId);
  await DirectiveConditionHistory.create({
    levelId,
    conditionHash,
  });
}

async function getAnnouncementDirectives(difficultyId: number, triggerType: 'PASS' | 'LEVEL', pass?: Pass, level?: Level) {
  const directives = await AnnouncementDirective.findAll({
    where: {
      difficultyId,
      isActive: true,
      triggerType,
    },
    order: [['sortOrder', 'ASC']], // Sort by sortOrder ascending
    include: [
      {
        model: DirectiveAction,
        as: 'actions',
        where: { isActive: true },
        required: false,
        include: [
          {
            model: AnnouncementChannel,
            as: 'channel',
            where: { isActive: true },
            required: true
          },
          {
            model: AnnouncementRole,
            as: 'role',
            where: { isActive: true },
            required: false
          }
        ]
      }
    ]
  });

  const filteredDirectives = await Promise.all(directives.map(async directive => {
    if (!pass || !level) return true;
    
    // For firstOfKind directives, we need to check if this condition was ever met before for this specific level
    if (directive.firstOfKind) {
      const conditionMet = await hasConditionBeenMetBefore(level.id, directive.condition);
      if (conditionMet) {
        return false; // Skip this directive if the condition was met before for this level
      }
      
      // If the condition is met now, record it for this level
      const isMet = evaluateCondition(directive.condition, pass, level);
      if (isMet) {
        await recordConditionMet(level.id, directive.condition);
      }
      return isMet;
    }
    
    return evaluateCondition(directive.condition, pass, level);
  }));

  return directives.filter((_, index) => filteredDirectives[index]);
}

function channelTypeToName(type: string): string {
  const mapping: {[key: string]: string} = {
    'PLANETARY': 'planetary-levels',
    'GALACTIC': 'galactic-levels',
    'UNIVERSAL': 'universal-levels',
    'CENSORED': 'censored-levels',
    'RERATES': 'rerates'
  };
  return mapping[type] || type.toLowerCase() + '-levels';
}

export async function getLevelAnnouncementConfig(
  level: Level,
  isRerate = false,
): Promise<AnnouncementConfig> {
  const difficulty = level?.difficulty;
  if (!difficulty) {
    return {webhooks: {}, pings: {}};
  }

  const directives = await getAnnouncementDirectives(difficulty.id, 'LEVEL', undefined, level);
  const config: AnnouncementConfig = {
    webhooks: {},
    pings: {},
  };

  // Track channels that have been processed
  const processedChannels = new Set<string>();

  // Process directives in order of priority (sortOrder)
  for (const directive of directives) {
    if (!directive.actions) continue;

    for (const action of directive.actions) {
      if (!action.channel) continue;
      
      const channelLabel = action.channel.label;
      
      // Skip if this channel has already been processed
      if (processedChannels.has(channelLabel)) continue;
      
      // Mark this channel as processed
      processedChannels.add(channelLabel);
      
      config.webhooks[channelLabel] = action.channel.webhookUrl;
      
      if (action.pingType === 'EVERYONE') {
        config.pings[channelLabel] = '@everyone';
      } else if (action.pingType === 'ROLE' && action.role?.roleId) {
        config.pings[channelLabel] = `<@&${action.role.roleId}>`;
      }
    }
  }

  return config;
}

function isPurePerect(pass: Pass): boolean {
  return pass.accuracy === 1.0;
}

function isNoMiss(pass: Pass): boolean {
  return pass.judgements?.earlyDouble === 0;
}

export async function getPassAnnouncementConfig(pass: Pass): Promise<AnnouncementConfig> {
  const difficulty = pass.level?.difficulty;
  if (!difficulty) {
    return {webhooks: {}, pings: {}};
  }

  const directives = await getAnnouncementDirectives(difficulty.id, 'PASS', pass, pass.level);
  const config: AnnouncementConfig = {
    webhooks: {},
    pings: {},
  };

  // Track channels that have been processed
  const processedChannels = new Set<string>();

  // Process directives in order of priority (sortOrder)
  for (const directive of directives) {
    if (!directive.actions) continue;

    for (const action of directive.actions) {
      if (!action.channel) continue;
      
      const channelLabel = action.channel.label;
      
      // Skip if this channel has already been processed
      if (processedChannels.has(channelLabel)) continue;
      
      // Mark this channel as processed
      processedChannels.add(channelLabel);
      
      config.webhooks[channelLabel] = action.channel.webhookUrl;
      
      if (action.pingType === 'EVERYONE') {
        config.pings[channelLabel] = '@everyone';
      } else if (action.pingType === 'ROLE' && action.role?.roleId) {
        config.pings[channelLabel] = `<@&${action.role.roleId}>`;
      }
    }
  }

  return config;
}

// Helper function to format pings for Discord
export function formatPings(config: AnnouncementConfig): {
  [key: string]: string;
} {
  return config.pings;
}
