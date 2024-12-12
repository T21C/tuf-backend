import {getIconUrl} from './iconResolver';
import {calculateBaseScore} from './ratingUtils';

export interface DifficultyEntry {
  id: number;
  name: string;
  type: 'PGU' | 'SPECIAL';
  icon: string;
  legacyIcon: string | null;
  baseScore: number;
  legacy: number;
  createdAt: Date;
  updatedAt: Date;
}

export const legacyMap = {
  P1: 1,
  P2: 3,
  P3: 4,
  P4: 5,
  P5: 6,
  P6: 7,
  P7: 8,
  P8: 9,
  P9: 10,
  P10: 11,
  P11: 12,
  P12: 13,
  P13: 14,
  P14: 15,
  P15: 16,
  P16: 17,
  P17: 18,
  P18: 18.5,
  P19: 19,
  P20: 19.5,
  G1: 20.0,
  G2: 20.05,
  G3: 20.1,
  G4: 20.15,
  G5: 20.2,
  G6: 20.25,
  G7: 20.3,
  G8: 20.35,
  G9: 20.4,
  G10: 20.45,
  G11: 20.5,
  G12: 20.55,
  G13: 20.6,
  G14: 20.65,
  G15: 20.7,
  G16: 20.75,
  G17: 20.8,
  G18: 20.85,
  G19: 20.9,
  G20: 20.95,
  U1: 21.0,
  U2: 21.0,
  U3: 21.05,
  U4: 21.05,
  U5: 21.1,
  U6: 21.1,
  U7: 21.15,
  U8: 21.15,
  U9: 21.2,
  U10: 21.2,
  U11: 21.25,
  U12: 21.25,
  U13: 21.3,
  U14: 21.3,
  U15: 21.35,
  U16: 21.35,
  U17: 21.4,
  U18: 21.4,
  U19: 21.45,
  U20: 21.45,
};

// Helper function to get legacy icon URL
// Add these at the top of the file with other imports
const baseURL = "https://github.com/T21C/T21C-assets/blob/main/";
const queryParams = "?raw=true";
function getLegacyIconUrl(legacyDiff: number): string | null {
  const legacyIconMap: { [key: string]: string } = {
    1: "lv01.png",
    2: "lv02.png",
    3: "lv03.png",
    4: "lv04.png",
    5: "lv05.png",
    6: "lv06.png",
    7: "lv07.png",
    8: "lv08.png",
    9: "lv09.png",
    10: "10.png",
    11: "11.png",
    12: "12.png",
    13: "13.png",
    14: "14.png",
    15: "15.png",
    16: "16.png",
    17: "17.png",
    18: "18.png",
    18.5: "18+.png",
    19: "19.png",
    19.5: "19+.png",
    20: "lvl20_0.png",
    20.05: "lv20__0p.png",
    20.1: "lv20__1.png",
    20.15: "lv20__1p.png",
    20.2: "lv20__2.png",
    20.25: "lv20__2p.png",
    20.3: "lv20__3.png",
    20.35: "lv20__3p.png",
    20.4: "lv20__4.png",
    20.45: "lv20__4p.png",
    20.5: "20.5.png",
    20.55: "20.5p.png",
    20.6: "20.6.png",
    20.65: "20.6p.png",
    20.7: "20.7.png",
    20.75: "20.7p.png",
    20.8: "20.8.png",
    20.85: "20.8p.png",
    20.9: "20.9.png",
    20.95: "20.9p.png",
    21: "21.png",
    21.05: "21p.png",
    21.1: "21.1.png",
    21.15: "21.1p.png",
    21.2: "21.2.png",
    21.25: "21.2p.png",
    21.3: "21.3.png",
    21.35: "21.3+.png",
  }

  // Special cases
  if (legacyDiff === -2) return `${baseURL}legacy/-2.png${queryParams}`;
  if (legacyDiff === -21) return `${baseURL}legacy/21-.png${queryParams}`;
  if (legacyDiff === -22) return `${baseURL}legacy/MP.png${queryParams}`;

  // Regular legacy difficulties
  const key = legacyDiff.toString();
  if (key in legacyIconMap) {
    return `${baseURL}legacyDiff/${legacyIconMap[key]}${queryParams}`;
  }

  return null;
}


export const difficultyMap: DifficultyEntry[] = [
  {
    id: 0,
    name: 'Unranked',
    type: 'SPECIAL',
    icon: getIconUrl('0'),
    legacyIcon: null,
    baseScore: 0,
    legacy: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },

  // P ratings (1-20)
  ...Array.from({length: 20}, (_, i) => ({
    id: i + 1,
    name: `P${i + 1}`,
    type: 'PGU' as const,
    icon: getIconUrl(`P${i + 1}`),
    legacyIcon: getLegacyIconUrl(legacyMap[`P${i + 1}` as keyof typeof legacyMap]),
    baseScore: calculateBaseScore(i + 1),
    legacy: legacyMap[`P${i + 1}` as keyof typeof legacyMap] as number,
    createdAt: new Date(),
    updatedAt: new Date(),
  })),

  // G ratings (21-40)
  ...Array.from({length: 20}, (_, i) => ({
    id: i + 21,
    name: `G${i + 1}`,
    type: 'PGU' as const,
    icon: getIconUrl(`G${i + 1}`),
    legacyIcon: getLegacyIconUrl(legacyMap[`G${i + 1}` as keyof typeof legacyMap]),
    baseScore: calculateBaseScore(i + 21),
    legacy: legacyMap[`G${i + 1}` as keyof typeof legacyMap] as number,
    createdAt: new Date(),
    updatedAt: new Date(),
  })),

  // U ratings (41-60)
  ...Array.from({length: 20}, (_, i) => ({
    id: i + 41,
    name: `U${i + 1}`,
    type: 'PGU' as const,
    icon: getIconUrl(`U${i + 1}`),
    legacyIcon: getLegacyIconUrl(legacyMap[`U${i + 1}` as keyof typeof legacyMap]),
    baseScore: calculateBaseScore(i + 41),
    legacy: legacyMap[`U${i + 1}` as keyof typeof legacyMap] as number,
    createdAt: new Date(),
    updatedAt: new Date(),
  })),

  // Special ratings
  {
    id: 61,
    name: 'MP',
    type: 'SPECIAL',
    icon: getIconUrl('MP'),
    legacyIcon: null,
    baseScore: 0,
    legacy: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 62,
    name: 'Grande',
    type: 'SPECIAL',
    icon: getIconUrl('Grande'),
    legacyIcon: null,
    baseScore: 0,
    legacy: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 63,
    name: 'MA',
    type: 'SPECIAL',
    icon: getIconUrl('MA'),
    legacyIcon: null,
    baseScore: 0,
    legacy: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 64,
    name: 'Bus',
    type: 'SPECIAL',
    icon: getIconUrl('Bus'),
    legacyIcon: null,
    baseScore: 0,
    legacy: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 80,
    name: 'Qq',
    type: 'SPECIAL',
    icon: getIconUrl('QQ'),
    legacyIcon: null,
    baseScore: 0,
    legacy: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 81,
    name: 'Q2',
    type: 'SPECIAL',
    icon: getIconUrl('Q2'),
    legacyIcon: null,
    baseScore: 0,
    legacy: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 82,
    name: 'Q2+',
    type: 'SPECIAL',
    icon: getIconUrl('Q2+'),
    legacyIcon: null,
    baseScore: 0,
    legacy: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 83,
    name: 'Q3',
    type: 'SPECIAL',
    icon: getIconUrl('Q3'),
    legacyIcon: null,
    baseScore: 0,
    legacy: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 84,
    name: 'Q3+',
    type: 'SPECIAL',
    icon: getIconUrl('Q3+'),
    legacyIcon: null,
    baseScore: 0,
    legacy: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 85,
    name: 'Q4',
    type: 'SPECIAL',
    icon: getIconUrl('Q4'),
    legacyIcon: null,
    baseScore: 0,
    legacy: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 1002,
    name: '-2',
    type: 'SPECIAL',
    icon: getIconUrl('-2'),
    legacyIcon: null,
    baseScore: 0,
    legacy: -2,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 1021,
    name: '-21',
    type: 'SPECIAL',
    icon: getIconUrl('-21'),
    legacyIcon: null,
    baseScore: 0,
    legacy: -21,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];
