import Pass from '../../models/passes/Pass.js';
import Level from '../../models/levels/Level.js';
import AnnouncementDirective from '../../models/announcements/AnnouncementDirective.js';
import DirectiveConditionHistory from '../../models/announcements/DirectiveConditionHistory.js';
import {ConditionOperator, DirectiveCondition, DirectiveConditionType} from '../../interfaces/models/index.js';
import AnnouncementChannel from '../../models/announcements/AnnouncementChannel.js';
import AnnouncementRole from '../../models/announcements/AnnouncementRole.js';
import DirectiveAction from '../../models/announcements/DirectiveAction.js';
import { evaluateDirectiveCondition } from '../../utils/data/directiveParser.js';
import crypto from 'crypto';
import { Op } from 'sequelize';
import Judgement from '../../models/passes/Judgement.js';
import { logger } from '../../services/LoggerService.js';

export interface MessageFormatConfig {
  messageFormat: string;
  ping: string; // The actual ping string (<@&roleId> or @everyone)
  roleId: number;
  actionId: number;
  directiveId: number; // Added to track which directive this format comes from
  directiveSortOrder: number; // Added to track directive priority
}

export interface AnnouncementChannelConfig {
  label: string;
  webhookUrl: string;
  ping?: string; // ping content (for backwards compatibility, default ping)
  directiveIds?: number[]; // array of directive ids
  actionIds?: number[]; // array of action ids
  messageFormats?: MessageFormatConfig[]; // array of message format configs
}

export interface AnnouncementConfig {
  channels: AnnouncementChannelConfig[];
}




function evaluateCondition(condition: DirectiveCondition, pass: Pass, level: Level): boolean {
  if (!condition) return true;


  switch (condition.type) {
    case DirectiveConditionType.ACCURACY:
      if (!condition.value || !condition.operator) return false;
      const accuracy = pass.accuracy || 0;
      const targetAccuracy = Number(condition.value);

      const result = (() => {
        switch (condition.operator) {
          case ConditionOperator.EQUAL:
            return accuracy === targetAccuracy;
          case ConditionOperator.GREATER_THAN:
            return accuracy > targetAccuracy;
          case ConditionOperator.LESS_THAN:
            return accuracy < targetAccuracy;
          case ConditionOperator.GREATER_THAN_EQUAL:
            return accuracy >= targetAccuracy;
          case ConditionOperator.LESS_THAN_OR_EQUAL:
            return accuracy <= targetAccuracy;
          default:
            return false;
        }
      })();


      return result;

    case DirectiveConditionType.WORLDS_FIRST:
      return pass.isWorldsFirst === true;

    case DirectiveConditionType.BASE_SCORE:
      if (!condition.value || !condition.operator || !level.baseScore) return false;
      const baseScore = level.baseScore;
      const targetScore = Number(condition.value);

      switch (condition.operator) {
        case ConditionOperator.EQUAL:
          return baseScore === targetScore;
        case ConditionOperator.GREATER_THAN:
          return baseScore > targetScore;
        case ConditionOperator.LESS_THAN:
          return baseScore < targetScore;
        case ConditionOperator.GREATER_THAN_EQUAL:
          return baseScore >= targetScore;
        case ConditionOperator.LESS_THAN_OR_EQUAL:
          return baseScore <= targetScore;
        default:
          return false;
      }

    case DirectiveConditionType.CUSTOM:
      if (!condition.customFunction) return false;
      try {
        return evaluateDirectiveCondition(condition.customFunction, pass, level);
      } catch (error) {
        logger.error('Error evaluating custom condition:', error);
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

async function hasConditionBeenMetBefore(level: Level, pass: Pass, condition: DirectiveCondition): Promise<boolean> {
  // First check the history table
  const conditionHash = generateConditionHash(condition, level.id);
  const history = await DirectiveConditionHistory.findOne({
    where: {
      levelId: level.id,
      conditionHash,
    },
  });

  if (history) {
    return true; // Condition has been recorded as met before
  }

  const otherPasses = await Pass.findAll({
    where: {
      levelId: level.id,
      id: {
        [Op.ne]: pass.id,
      },
      isDeleted: false,
    },
    include: [
      {
        model: Judgement,
        as: 'judgements',
        required: true,
      },
    ],
  });
  // If no history record exists, check all existing passes for this level
  // to determine if any previous pass would have met this condition

  if (otherPasses.length === 0) {
    return false; // No passes exist for this level, so condition hasn't been met before
  }
  // Check each pass to see if it would have met the condition
  for (const otherPass of otherPasses) {
    // Cast the pass to the correct type expected by evaluateCondition
   if (evaluateCondition(condition, otherPass as Pass, level as Level)) {
      // Found a pass that meets the condition, so it's not truly first of its kind
      await recordConditionMet(level.id, condition);
      return true;
    }
  }

  // No previous pass meets the condition, so this is truly first of its kind
  return false;
}

async function recordConditionMet(levelId: number, condition: DirectiveCondition): Promise<void> {
  const conditionHash = generateConditionHash(condition, levelId);
  await DirectiveConditionHistory.create({
    levelId,
    conditionHash,
  });
}

async function getAnnouncementDirectives(difficultyId: number, triggerType: 'PASS' | 'LEVEL', pass?: Pass, level?: Level) {
  // Fetch directives ordered by sortOrder (lower number = higher priority)
  // Return ALL matching directives (not just first) to allow combination
  const directives = await AnnouncementDirective.findAll({
    where: {
      difficultyId,
      isActive: true,
      triggerType,
    },
    order: [['sortOrder', 'ASC'], ['id', 'ASC']], // Order by sortOrder, then by id for consistency
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

  // Evaluate directives in order and return ALL matching ones (must have actions)
  const matchingDirectives: AnnouncementDirective[] = [];

  for (const directive of directives) {
    if (!pass || !level) {
      // If no pass/level provided, include first directive with actions
      if (directive.actions && directive.actions.length > 0) {
        matchingDirectives.push(directive);
        break; // Only return first when no pass/level
      }
      continue;
    }

    let matches = false;

    // For firstOfKind directives, we need to check if this condition was ever met before for this specific level
    if (directive.firstOfKind) {
      const conditionMet = await hasConditionBeenMetBefore(level, pass, directive.condition);
      if (conditionMet) {
        continue; // Skip this directive if the condition was met before for this level
      }

      // If the condition is met now, record it for this level
      const isMet = evaluateCondition(directive.condition, pass, level);
      if (isMet) {
        await recordConditionMet(level.id, directive.condition);
      }
      matches = isMet;
    } else {
      matches = evaluateCondition(directive.condition, pass, level);
    }

    // Add matching directive if it has actions
    if (matches && directive.actions && directive.actions.length > 0) {
      matchingDirectives.push(directive);
    }
  }

  return matchingDirectives;
}

export async function getLevelAnnouncementConfig(
  level: Level,
): Promise<AnnouncementConfig> {
  const difficulty = level?.difficulty;
  if (!difficulty) {
    return {channels: []};
  }

  const directives = await getAnnouncementDirectives(difficulty.id, 'LEVEL', undefined, level);
  const channels: AnnouncementChannelConfig[] = [];

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

      const channelConfig: AnnouncementChannelConfig = {
        label: channelLabel,
        webhookUrl: action.channel.webhookUrl,
      };

      if (action.pingType === 'EVERYONE') {
        channelConfig.ping = '@everyone';
      } else if (action.pingType === 'ROLE' && action.role?.roleId) {
        channelConfig.ping = `<@&${action.role.roleId}>`;
      }

      channels.push(channelConfig);
    }
  }

  return {channels};
}


export async function getPassAnnouncementConfig(pass: Pass): Promise<AnnouncementConfig> {
  const difficulty = pass.level?.difficulty;
  if (!difficulty) {
    return {channels: []};
  }

  const directives = await getAnnouncementDirectives(difficulty.id, 'PASS', pass, pass.level);
  const channelsMap = new Map<string, AnnouncementChannelConfig>();

  // Process ALL matching directives in order of priority (sortOrder)
  // Multiple directives can match the same pass (e.g., PP directive + U9 directive)
  for (const directive of directives) {
    if (!directive.actions) {
      continue;
    }

    for (const action of directive.actions) {
      if (!action.channel) continue;

      const channelLabel = action.channel.label;

      // Get or create channel config
      let channelConfig = channelsMap.get(channelLabel);
      if (!channelConfig) {
        channelConfig = {
          label: channelLabel,
          webhookUrl: action.channel.webhookUrl,
          directiveIds: [],
          actionIds: [],
          messageFormats: [],
        };
        channelsMap.set(channelLabel, channelConfig);
      }

      // Store directive ID and action ID
      if (directive.id && !channelConfig.directiveIds!.includes(directive.id)) {
        channelConfig.directiveIds!.push(directive.id);
      }
      if (action.id && !channelConfig.actionIds!.includes(action.id)) {
        channelConfig.actionIds!.push(action.id);
      }

      // Check if action has ROLE ping type - use messageFormat or default
      if (action.pingType === 'ROLE' && action.role) {
        // Use role's messageFormat or default format (note: count is lowercase in template but uppercase in render)
        const messageFormat = action.role.messageFormat || '{count} New {difficultyName} clears {ping}';
        
        const ping = action.role.roleId ? `<@&${action.role.roleId}>` : '';

        channelConfig.messageFormats!.push({
          messageFormat,
          ping,
          roleId: action.role.id!,
          actionId: action.id!,
          directiveId: directive.id!,
          directiveSortOrder: directive.sortOrder || 0,
        });

      } else if (action.pingType === 'EVERYONE') {
        // EVERYONE ping - set ping if not already set
        if (!channelConfig.ping) {
          channelConfig.ping = '@everyone';
        }
      } else {
        // No ping or NONE ping type - no action needed
      }
    }
  }

  const channels = Array.from(channelsMap.values());
  return {channels};
}

