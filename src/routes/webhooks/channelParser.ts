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

interface AnnouncementConfig {
  webhooks: {
    [key: string]: string; // channel label -> webhook URL
  };
  pings: {
    [key: string]: string; // channel label -> ping content (for backwards compatibility, default ping)
  };
  directiveIds?: {
    [key: string]: number[]; // channel label -> array of directive ids (changed to array)
  };
  actionIds?: {
    [key: string]: number[]; // channel label -> array of action ids (changed to array)
  };
  messageFormats?: {
    [key: string]: MessageFormatConfig[]; // channel label -> array of message format configs
  };
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
        logger.debug(`[Directive Match] Pass/Level not provided, using first directive: ${directive.id} (sortOrder: ${directive.sortOrder})`);
        break; // Only return first when no pass/level
      }
      continue;
    }

    let matches = false;

    // For firstOfKind directives, we need to check if this condition was ever met before for this specific level
    if (directive.firstOfKind) {
      const conditionMet = await hasConditionBeenMetBefore(level, pass, directive.condition);
      if (conditionMet) {
        logger.debug(`[Directive Match] Directive ${directive.id} (firstOfKind) skipped - condition met before for level ${level.id}`);
        continue; // Skip this directive if the condition was met before for this level
      }

      // If the condition is met now, record it for this level
      const isMet = evaluateCondition(directive.condition, pass, level);
      if (isMet) {
        await recordConditionMet(level.id, directive.condition);
      }
      matches = isMet;
      if (matches) {
        logger.debug(`[Directive Match] Directive ${directive.id} (firstOfKind) MATCHED for pass ${pass.id}, level ${level.id}`);
      }
    } else {
      matches = evaluateCondition(directive.condition, pass, level);
      if (matches) {
        logger.debug(`[Directive Match] Directive ${directive.id} (sortOrder: ${directive.sortOrder}) MATCHED for pass ${pass.id}, level ${level.id}`);
      }
    }

    // Add matching directive if it has actions
    if (matches && directive.actions && directive.actions.length > 0) {
      matchingDirectives.push(directive);
      logger.debug(`[Directive Match] Added directive ${directive.id} with ${directive.actions.length} action(s)`);
    }
  }

  logger.debug(`[Directive Match] Total matching directives for pass ${pass?.id || 'N/A'}, level ${level?.id || 'N/A'}: ${matchingDirectives.length}`);
  return matchingDirectives;
}

export async function getLevelAnnouncementConfig(
  level: Level,
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


export async function getPassAnnouncementConfig(pass: Pass): Promise<AnnouncementConfig> {
  const difficulty = pass.level?.difficulty;
  if (!difficulty) {
    return {webhooks: {}, pings: {}};
  }

  const directives = await getAnnouncementDirectives(difficulty.id, 'PASS', pass, pass.level);
  const config: AnnouncementConfig = {
    webhooks: {},
    pings: {},
    directiveIds: {},
    actionIds: {},
    messageFormats: {},
  };

  // Track channels that have been processed (for non-formatted messages)
  const processedChannels = new Set<string>();

  // Process ALL matching directives in order of priority (sortOrder)
  // Multiple directives can match the same pass (e.g., PP directive + U9 directive)
  logger.debug(`[Config Build] Processing ${directives.length} matching directive(s) for pass ${pass.id}`);
  
  for (const directive of directives) {
    if (!directive.actions) {
      logger.debug(`[Config Build] Directive ${directive.id} has no actions, skipping`);
      continue;
    }

    logger.debug(`[Config Build] Processing directive ${directive.id} (sortOrder: ${directive.sortOrder}) with ${directive.actions.length} action(s)`);

    for (const action of directive.actions) {
      if (!action.channel) continue;

      const channelLabel = action.channel.label;

      // Set webhook URL
      config.webhooks[channelLabel] = action.channel.webhookUrl;

      // Store directive ID and action ID as arrays (multiple directives per channel)
      if (!config.directiveIds) {
        config.directiveIds = {};
      }
      if (!config.actionIds) {
        config.actionIds = {};
      }
      if (!config.directiveIds[channelLabel]) {
        config.directiveIds[channelLabel] = [];
      }
      if (!config.actionIds[channelLabel]) {
        config.actionIds[channelLabel] = [];
      }
      if (directive.id && !config.directiveIds[channelLabel].includes(directive.id)) {
        config.directiveIds[channelLabel].push(directive.id);
      }
      if (action.id && !config.actionIds[channelLabel].includes(action.id)) {
        config.actionIds[channelLabel].push(action.id);
      }

      // Check if action has ROLE ping type - use messageFormat or default
      if (action.pingType === 'ROLE' && action.role) {
        // Use role's messageFormat or default format (note: count is lowercase in template but uppercase in render)
        const messageFormat = action.role.messageFormat || '{count} New {difficultyName} clears {ping}';
        
        if (!config.messageFormats) {
          config.messageFormats = {};
        }
        if (!config.messageFormats[channelLabel]) {
          config.messageFormats[channelLabel] = [];
        }

        const ping = action.role.roleId ? `<@&${action.role.roleId}>` : '';

        config.messageFormats[channelLabel].push({
          messageFormat,
          ping,
          roleId: action.role.id!,
          actionId: action.id!,
          directiveId: directive.id!,
          directiveSortOrder: directive.sortOrder || 0,
        });

        logger.debug(`[Config Build] Added ROLE message format for channel "${channelLabel}": "${messageFormat}" with ping ${ping} (directive ${directive.id}, role ${action.role.id})`);
      } else if (action.pingType === 'EVERYONE') {
        // EVERYONE ping - use legacy ping system
        if (!processedChannels.has(channelLabel)) {
          processedChannels.add(channelLabel);
          config.pings[channelLabel] = '@everyone';
          logger.debug(`[Config Build] Added EVERYONE ping for channel "${channelLabel}" (directive ${directive.id})`);
        }
      } else {
        // No ping or NONE ping type - no action needed
        logger.debug(`[Config Build] Action ${action.id} has pingType "${action.pingType}", no ping added`);
      }
    }
  }

  logger.debug(`[Config Build] Final config for pass ${pass.id}: ${Object.keys(config.webhooks).length} channel(s), ${Object.keys(config.messageFormats || {}).length} channel(s) with message formats`);
  return config;
}

// Helper function to format pings for Discord
export function formatPings(config: AnnouncementConfig): {
  [key: string]: string;
} {
  return config.pings;
}
