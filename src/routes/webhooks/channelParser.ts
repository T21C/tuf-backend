import Pass from '../../models/Pass.js';
import Level from '../../models/Level.js';
import AnnouncementDirective from '../../models/AnnouncementDirective.js';
import {DirectiveCondition} from '../../interfaces/models/index.js';
import AnnouncementChannel from '../../models/AnnouncementChannel.js';
import AnnouncementRole from '../../models/AnnouncementRole.js';
import DirectiveAction from '../../models/DirectiveAction.js';
import { evaluateDirectiveCondition } from '../../utils/directiveParser.js';

interface AnnouncementConfig {
  webhooks: {
    [key: string]: string; // channel label -> webhook URL
  };
  pings: {
    [key: string]: string; // channel label -> ping content
  };
}

// Difficulty name patterns
const PATTERN = {
  P: /^P\d+$/, // P1-P20.
  G: /^G\d+$/, // G1-G20
  U: /^U\d+$/, // U1-U20
  Q: /^Q\d+(\+)?$/, // Q2, Q2+, Q3, Q3+, Q4
  SPECIAL: /^(MP|Grande|MA|Bus|Qq|-2|-21)$/,
};

function getDifficultyType(diffName: string): string {
  if (PATTERN.P.test(diffName)) return 'P';
  if (PATTERN.G.test(diffName)) return 'G';
  if (PATTERN.U.test(diffName)) return 'U';
  if (PATTERN.Q.test(diffName)) return 'Q';
  if (PATTERN.SPECIAL.test(diffName)) return 'SPECIAL';
  return 'UNKNOWN';
}

function getDifficultyNumber(diffName: string): number {
  const match = diffName.match(/\d+/);
  return match ? parseInt(match[0]) : 0;
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

async function getAnnouncementDirectives(difficultyId: number, triggerType: 'PASS' | 'LEVEL', pass?: Pass, level?: Level) {


  const directives = await AnnouncementDirective.findAll({
    where: {
      difficultyId,
      isActive: true,
      triggerType,
    },
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


  const filteredDirectives = directives.filter(directive => {
    if (!pass || !level) return true;
    const result = evaluateCondition(directive.condition, pass, level);
    

    
    return result;
  });



  return filteredDirectives;
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

  // Handle censored levels (-2)
  if (difficulty.name === '-2' || difficulty.name === '-21') {

    return {
      webhooks: {},
      pings: {},
    };
  }

  const directives = await getAnnouncementDirectives(difficulty.id, 'LEVEL', undefined, level);
  const config: AnnouncementConfig = {
    webhooks: {},
    pings: {},
  };

  // Process directives
  for (const directive of directives) {
    if (!directive.actions) continue;

    for (const action of directive.actions) {
      if (!action.channel) continue;
      
      const channelLabel = action.channel.label;
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
  if (!difficulty || difficulty.name === '-2' || difficulty.name === '0') {

    return {webhooks: {}, pings: {}};
  }

  const directives = await getAnnouncementDirectives(difficulty.id, 'PASS', pass, pass.level);
  const config: AnnouncementConfig = {
    webhooks: {},
    pings: {},
  };

  // Process directives
  for (const directive of directives) {
    if (!directive.actions) continue;



    for (const action of directive.actions) {
      if (!action.channel) continue;
      
      const channelLabel = action.channel.label;
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
