import Pass from '../../models/Pass.js';
import Level from '../../models/Level.js';
interface AnnouncementConfig {
  channels: string[];
  pings: {
    [key: string]: string; // channel name -> ping type
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

export function getLevelAnnouncementConfig(
  level: Level,
  isRerate = false,
): AnnouncementConfig {
  const difficulty = level?.difficulty;
  if (!difficulty) {
    return {channels: [], pings: {}};
  }

  const diffName = difficulty.name;
  const config: AnnouncementConfig = {
    channels: [],
    pings: {},
  };

  // Handle censored levels (-2)
  if (diffName === '-2') {
    config.channels.push('censored-levels');
    return config;
  }

  // Handle rerates
  if (isRerate) {
    config.channels.push('rerates');
    // Add ping based on difficulty type
    config.pings['rerates'] = `<@&${process.env.RERATE_PING_ROLE_ID}>`;
    return config;
  }

  // Handle new levels
  if (diffName.startsWith('P')) {
    config.channels.push('planetary-levels');
    config.pings['planetary-levels'] =
      `<@&${process.env.PLANETARY_PING_ROLE_ID}>`;
  } else if (diffName.startsWith('G')) {
    config.channels.push('galactic-levels');
    config.pings['galactic-levels'] =
      `<@&${process.env.GALACTIC_PING_ROLE_ID}>`;
  } else {
    config.channels.push('universal-levels');
    config.pings['universal-levels'] =
      `<@&${process.env.UNIVERSAL_PING_ROLE_ID}>`;
  }
  return config;
}

function isPurePerect(pass: Pass): boolean {
  return pass.accuracy === 1.0;
}

function isNoMiss(pass: Pass): boolean {
  return pass.judgements?.earlyDouble === 0;
}

export function getPassAnnouncementConfig(pass: Pass): AnnouncementConfig {
  const difficulty = pass.level?.difficulty;
  if (!difficulty || difficulty.name === '-2' || difficulty.name === '0') {
    return {channels: [], pings: {}};
  }

  const diffName = difficulty.name;
  const diffType = getDifficultyType(diffName);
  const diffNumber = getDifficultyNumber(diffName);
  const isWF = pass.isWorldsFirst;
  const isPP = isPurePerect(pass);

  const config: AnnouncementConfig = {
    channels: [],
    pings: {},
  };

  // Add channels based on flags and determine their pings
  if (isWF) {
    config.channels.push('wf-clears');
    if (diffType !== 'P') {
      config.pings['wf-clears'] = '@wf ping';
    }
  }

  if (isPP) {
    config.channels.push('pp-clears');
    if (diffType !== 'P') {
      config.pings['pp-clears'] = '@pp ping';
    }
  }

  // Determine pings based on difficulty and flags
  switch (diffType) {
    case 'P':
      // P levels don't get pings
      config.pings['universal-clears'] = '';
      break;

    case 'G':
      break;

    case 'U':
      config.channels.push('universal-clears');
      if (pass.accuracy === 1.0) {
        config.pings['universal-clears'] = '@everyone';
      }
      // U1-U6: Universal ping for clear
      else if (diffNumber <= 6) {
        config.pings['universal-clears'] = '@universal ping';
      }
      // U7-U9: Universal ping for clear, WF gets everyone
      else if (diffNumber <= 9) {
        config.pings['universal-clears'] = isWF
          ? '@everyone'
          : '@universal ping';
      }
      // U10: Universal ping for clear, no miss gets everyone
      else if (diffNumber === 10) {
        config.pings['universal-clears'] = isNoMiss(pass)
          ? '@everyone'
          : '@universal ping';
      }
      // U11+: Everyone ping for everything
      else {
        config.pings['universal-clears'] = '@everyone';
      }
      break;

    case 'Q':
      config.channels.push('universal-clears');
      config.pings['universal-clears'] = '@everyone';
      break;

    case 'SPECIAL':
      config.channels.push('universal-clears');
      switch (diffName) {
        case 'MP':
        case 'Grande':
        case 'MA':
        case 'Bus':
          config.pings['universal-clears'] = '@universal ping';
          break;
        case '-21':
          config.pings['universal-clears'] = '@everyone';
          break;
        default:
          config.pings['universal-clears'] = '';
      }
      break;
  }

  return config;
}

// Helper function to format pings for Discord
export function formatPings(config: AnnouncementConfig): {
  [key: string]: string;
} {
  return config.pings;
}
