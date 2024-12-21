import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {getIconUrl} from './iconResolver';
import {calculateBaseScore} from './ratingUtils';

// Fix __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface DifficultyEntry {
  id: number;
  name: string;
  type: 'PGU' | 'SPECIAL';
  icon: string;
  legacyIcon: string | null;
  legacyEmoji: string | null;
  emoji: string;
  baseScore: number;
  sortOrder: number;
  legacy: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}



export const colorMap: {[key: string]: string} = {
  "0": "#ffffff",
  "-2": "#434343",
  "-21": "#ceadff",
  "MP": "#ffffff",
  "Grande": "#ffffff",
  "MA": "#ffffff",
  "Bus": "#ffffff",
  "Q1+": "#443a57",
  "Q2": "#2f2b36",
  "Q2+": "#241f1f:",
  "Q3": "#000000",
  "Q3+": "#000000",
  "Q4": "#000000",
  "Qq": "#ffffff",
  "P1": "#0099ff",
  "P2": "#00a2ff",
  "P3": "#00aaff",
  "P4": "#00b2ff",
  "P5": "#00bbff",
  "P6": "#00c3ff",
  "P7": "#00ccff",
  "P8": "#00ddff",
  "P9": "#00e5ff",
  "P10": "#00eeff",
  "P11": "#00ffff",
  "P12": "#00ffe8",
  "P13": "#00ffd0",
  "P14": "#00ffb8",
  "P15": "#00ffaa",
  "P16": "#00ff88",
  "P17": "#00ff70",
  "P18": "#00ff48",
  "P19": "#00ff30",
  "P20": "#44ff15",
  "G1": "#F2A700",
  "G2": "#F09E08",
  "G3": "#EE9510",
  "G4": "#ED8C18",
  "G5": "#EB8420",
  "G6": "#EA7B28",
  "G7": "#E87230",
  "G8": "#E66938",
  "G9": "#E56040",
  "G10": "#E35848",
  "G11": "#E14F4F",
  "G12": "#E04657",
  "G13": "#DE3D5F",
  "G14": "#DC3467",
  "G15": "#DB2C6F",
  "G16": "#D92377",
  "G17": "#D71A7F",
  "G18": "#D61187",
  "G19": "#D4088F",
  "G20": "#D20097",
  "U1": "#7B4FB2",
  "U2": "#744AA8",
  "U3": "#6E469F",
  "U4": "#674295",
  "U5": "#613E8C",
  "U6": "#5A3A83",
  "U7": "#543679",
  "U8": "#4D3170",
  "U9": "#472D67",
  "U10": "#40295D",
  "U11": "#3A2554",
  "U12": "#33214A",
  "U13": "#2D1D41",
  "U14": "#261838",
  "U15": "#20142E",
  "U16": "#191025",
  "U17": "#130C1C",
  "U18": "#0C0812",
  "U19": "#060409",
  "U20": "#000000"
}





export const legacyEmojiMap: {[key: string]: string} = {
  "-1": "<:lv1f:1053888868056830024>",
  "-2": "<:lv2f:1053888866769190983>",
  "-21": "<:m21:1213912547250540584>",
  "MP": "<:tMapPack:1094918363161051147>",
  "Grande": "<:Grande:1215168921775382628>",
  "MA": "<:ma:1053888876424478720>",
  "Bus": "<:tdesertbus:1046176604864401600>",
  "1": "<:lv1:1190578267103707246>",
  "2": "<:lv2:1190578269054050324>", 
  "3": "<:lv3:1190578272661159966>",
  "4": "<:lv4:1190578276251467896>",
  "5": "<:lv5:1190578279955050528>",
  "6": "<:lv6:1190578282001858560>",
  "7": "<:lv7:1190578285332156467>",
  "8": "<:lv8:1190578289341902890>",
  "9": "<:lv9:1190578291476799630>",
  "10": "<:lv10:1190576974326943866>",
  "11": "<:lv11:1190576976793178112>",
  "12": "<:lv12:1190576980257685605>",
  "13": "<:lv13:1190576983839617087>",
  "14": "<:lv14:1190576987488653322>",
  "15": "<:lv15:1190576989476765826>",
  "16": "<:lv16:1190576994241482816>",
  "17": "<:lv17:1190576997773099039>",
  "18": "<:lv18:1053887761683333160>",
  "18+": "<:lv18p:1053887763516231680>",
  "19": "<:lv19:1053887675788177469>",
  "19+": "<:lv19p:1053887765105872927>",
  "20.0": "<:lv20:1068169467932180502>",
  "20.0+": "<:lv20p:1068169439629017190>",
  "20.1": "<:lv201:1068169442342735973>",
  "20.1+": "<:lv201p:1068169446184734811>",
  "20.2": "<:lv202:1068169447921156149>",
  "20.2+": "<:lv202p:1068169451536666654>",
  "20.3": "<:lv203:1068169455303147680>",
  "20.3+": "<:lv203p:1068169457182191616>",
  "20.4": "<:lv204:1068169460831244338>",
  "20.4+": "<:lv204p:1068169464262176880>",
  "20.5": "<:lv205:1068169378450911302>",
  "20.5+": "<:lv205p:1068169380527095838>",
  "20.6": "<:lv206:1068169384377454612>",
  "20.6+": "<:lv206p:1068169387871305838>",
  "20.7": "<:lv207:1068169391126085653>",
  "20.7+": "<:lv207p:1068169392661221499>",
  "20.8": "<:lv208:1068169397023281203>",
  "20.8+": "<:lv208p:1068169398881374268>",
  "20.9": "<:lv209:1068169402249384006>",
  "20.9+": "<:lv209p:1068169405944582295>",
  "21": "<:lv21:1068169431202680953>",
  "21+": "<:lv21p:1068169436294557807>",
  "21.1": "<:lv211:1068169411506229408>",
  "21.1+": "<:lv211p:1068169413242650704>",
  "21.2": "<:lv212:1068169419022401636>",
  "21.2+": "<:lv212p:1068169424227537006>",
  "21.3": "<:lv213:1068169426559574077>",
  "21.3+": "<:lv213p:1084401808040017991>"
};



export const emojiMap: {[key: string]: string} = {
  "0": "<:lv00:1044194459417591858>",
  "-2": "<:lv2f:1053888866769190983>",
  "-21": "<:lv21f:1053888870187524116>",
  "MP": "<:mp:1053888872284696576>",
  "Grande": "<:grande:1053888874373476352>",
  "MA": "<:ma:1053888876424478720>",
  "Bus": "<:bus:1053888878471286784>",
  "Q1+": "<:Q1p:1221237405508567111>",
  "Q2": "<:Q2:1221237407400198224>",
  "Q2+": "<:Q2p:1221237409623314523>",
  "Q3": "<:Q3:1221237411443642378>",
  "Q3+": "<:Q3p:1200739386124410890>",
  "Q4": "<:Q4:1285953169028939881>",
  "Qq": "<:Qq:1285945451954049126>",
  "P1": "<:P1:1213795768339660820>",
  "P2": "<:P2:1213795770952851516>",
  "P3": "<:P3:1213795773502857246>",
  "P4": "<:P4:1213795776698785802>",
  "P5": "<:P5:1213811713649020928>",
  "P6": "<:P6:1213811715897032724>",
  "P7": "<:P7:1213811718329991168>",
  "P8": "<:P8:1213811720796241950>",
  "P9": "<:P9:1213811723048325130>",
  "P10": "<:P10:1213811725460308009>",
  "P11": "<:P11:1213811727934685204>",
  "P12": "<:P12:1213811730379964456>",
  "P13": "<:P13:1213811733328826439>",
  "P14": "<:P14:1213811735320858634>",
  "P15": "<:P15:1213811737711742976>",
  "P16": "<:P16:1213811739985055766>",
  "P17": "<:P17:1213811743034179614>",
  "P18": "<:P18:1213811745588645898>",
  "P19": "<:P19:1213811747652370482>",
  "P20": "<:P20:1213811749795528704>",
  "G1": "<:G1:1213795712031133696>",
  "G2": "<:G2:1213795714862424074>",
  "G3": "<:G3:1213795718284972032>",
  "G4": "<:G4:1213795720403095614>",
  "G5": "<:G5:1213795722969747456>",
  "G6": "<:G6:1213795725373210645>",
  "G7": "<:G7:1213795728346849300>",
  "G8": "<:G8:1213795731387719720>",
  "G9": "<:G9:1213795734651146310>",
  "G10": "<:G10:1213795737431965716>",
  "G11": "<:G11:1213795740187365386>",
  "G12": "<:G12:1213795743358390323>",
  "G13": "<:G13:1213795746034221057>",
  "G14": "<:G14:1213795749070897182>",
  "G15": "<:G15:1213795751667302422>",
  "G16": "<:G16:1213795755228135444>",
  "G17": "<:G17:1213795758080532520>",
  "G18": "<:G18:1213795761003954218>",
  "G19": "<:G19:1213795763654758430>",
  "G20": "<:G20:1213795766309617664>",
  "U1": "<:U1:1213795637967986699>",
  "U2": "<:U2:1213795643047419944>",
  "U3": "<:U3:1213795647317348362>",
  "U4": "<:U4:1213795650001576007>",
  "U5": "<:U5:1213795652413427782>",
  "U6": "<:U6:1213795656200622160>",
  "U7": "<:U7:1213795661376651294>",
  "U8": "<:U8:1213795664597614612>",
  "U9": "<:U9:1213795668120961024>",
  "U10": "<:U10:1213795670792740874>",
  "U11": "<:U11:1213795675914113064>",
  "U12": "<:U12:1213795678527033405>",
  "U13": "<:U13:1213795682499174470>",
  "U14": "<:U14:1213795685854613525>",
  "U15": "<:U15:1213795689553993808>",
  "U16": "<:U16:1213795693471473685>",
  "U17": "<:U17:1213795697435082812>",
  "U18": "<:U18:1213795701041930241>",
  "U19": "<:U19:1213795704841965638>",
  "U20": "<:U20:1213795709745233930>"
}


export const legacyMap = {
  P1: "1",
  P2: "3",
  P3: "4",
  P4: "5",
  P5: "6",
  P6: "7",
  P7: "8",
  P8: "9",
  P9: "10",
  P10: "11",
  P11: "12",
  P12: "13",
  P13: "14",
  P14: "15",
  P15: "16",
  P16: "17",
  P17: "18",
  P18: "18+",
  P19: "19",
  P20: "19+",
  G1: "20.0",
  G2: "20.0+",
  G3: "20.1",
  G4: "20.1+",
  G5: "20.2",
  G6: "20.2+",
  G7: "20.3",
  G8: "20.3+",
  G9: "20.4",
  G10: "20.4+",
  G11: "20.5",
  G12: "20.5+",
  G13: "20.6",
  G14: "20.6+",
  G15: "20.7",
  G16: "20.7+",
  G17: "20.8",
  G18: "20.8+",
  G19: "20.9",
  G20: "20.9+",
  U1: "21",
  U2: "21",
  U3: "21+",
  U4: "21+",
  U5: "21.1",
  U6: "21.1",
  U7: "21.1+",
  U8: "21.1+",
  U9: "21.2",
  U10: "21.2",
  U11: "21.2+",
  U12: "21.2+",
  U13: "21.3",
  U14: "21.3",
  U15: "21.3+",
  U16: "21.3+",
  U17: "21.4",
  U18: "21.4",
  U19: "21.4+",
  U20: "21.4+"
};

// Helper function to get legacy icon URL
// Add these at the top of the file with other imports
const baseURL = 'https://github.com/T21C/T21C-assets/blob/main/';
const queryParams = '?raw=true';
function getLegacyIconUrl(legacyDiff: string): string | null {
  const legacyIconMap: {[key: string]: string} = {
    "1": 'lv01.png',
    "2": 'lv02.png',
    "3": 'lv03.png',
    "4": 'lv04.png',
    "5": 'lv05.png',
    "6": 'lv06.png',
    "7": 'lv07.png',
    "8": 'lv08.png',
    "9": 'lv09.png',
    "10": '10.png',
    "11": '11.png',
    "12": '12.png',
    "13": '13.png',
    "14": '14.png',
    "15": '15.png',
    "16": '16.png',
    "17": '17.png',
    "18": '18.png',
    "18+": '18+.png',
    "19": '19.png',
    "19+": '19+.png',
    "20.0": 'lvl20_0.png',
    "20.0+": 'lv20__0p.png',
    "20.1": 'lv20__1.png',
    "20.1+": 'lv20__1p.png',
    "20.2": 'lv20__2.png',
    "20.2+": 'lv20__2p.png',
    "20.3": 'lv20__3.png',
    "20.3+": 'lv20__3p.png',
    "20.4": 'lv20__4.png',
    "20.4+": 'lv20__4p.png',
    "20.5": '20.5.png',
    "20.5+": '20.5p.png',
    "20.6": '20.6.png',
    "20.6+": '20.6p.png',
    "20.7": '20.7.png',
    "20.7+": '20.7p.png',
    "20.8": '20.8.png',
    "20.8+": '20.8p.png',
    "20.9": '20.9.png',
    "20.9+": '20.9p.png',
    "21": '21.png',
    "21+": '21p.png',
    "21.1": '21.1.png',
    "21.1+": '21.1p.png',
    "21.2": '21.2.png',
    "21.2+": '21.2p.png',
    "21.3": '21.3.png',
    "21.3+": '21.3+.png',
  };

  // Special cases
  if (legacyDiff === "-2") return `${baseURL}miscDiff/-2.png${queryParams}`;
  if (legacyDiff === "-21") return `${baseURL}miscDiff/21-.png${queryParams}`;
  if (legacyDiff === "-22") return `${baseURL}miscDiff/MP.png${queryParams}`;

  // Regular legacy difficulties
  const key = legacyDiff.toString();
  if (key in legacyIconMap) {
    return `${baseURL}legacyDiff/${legacyIconMap[key]}${queryParams}`;
  }

  return null;
}

const mainDiffConst = 1000;
const qDiffConst = 10000;
// Cache directory path using resolved dirname
const ICON_CACHE_DIR = path.join(__dirname, '../../cache/icons');
const IMAGE_API = process.env.IMAGE_API || '/api/images';
const OWN_URL = process.env.OWN_URL || 'http://localhost:3000';

// Helper function to download and cache icons
async function cacheIcon(iconUrl: string, diffName: string): Promise<string> {
  try {
    await fs.mkdir(ICON_CACHE_DIR, { recursive: true });
    const fileName = `${diffName.replace(/[^a-zA-Z0-9]/g, '_')}.png`;
    const filePath = path.join(ICON_CACHE_DIR, fileName);

    if (!(await fs.stat(filePath).catch(() => false))) {
      const response = await axios.get(iconUrl, { responseType: 'arraybuffer' });
      await fs.writeFile(filePath, Buffer.from(response.data));
    }

    return `${OWN_URL}${IMAGE_API}/icon/${fileName}`;
  } catch (error) {
    console.error(`Failed to cache icon for ${diffName}:`, error);
    return iconUrl;
  }
}

// Initialize without caching first
export const initializeDifficultyMap = async (transaction?: any): Promise<DifficultyEntry[]> => {
  
  // Create special ratings first
  const specialRatings = [
    {
      id: 0,
      name: 'Unranked',
      type: 'SPECIAL' as const,
      icon: getIconUrl('0'),
      legacyIcon: null,
      baseScore: 0,
      sortOrder: 0,
      legacy: '0',
      legacyEmoji: null,
      emoji: emojiMap['0'],
      color: colorMap['0'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },    
        
    {
      id: mainDiffConst,
      name: '-2',
      type: 'SPECIAL' as const,
      icon: getIconUrl('-2'),
      legacyIcon: getLegacyIconUrl('-2'),
      baseScore: 0,
      sortOrder: mainDiffConst-1,
      legacy: '-2',
      legacyEmoji: legacyEmojiMap['-2'],
      emoji: emojiMap['-2'],
      color: colorMap['-2'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: mainDiffConst+1,
      name: 'Grande',
      type: 'SPECIAL' as const,
      icon: getIconUrl('Grande'),
      legacyIcon: getLegacyIconUrl('100'),
      baseScore: 0,
      sortOrder: mainDiffConst,
      legacy: '100',
      legacyEmoji: legacyEmojiMap['100'],
      emoji: emojiMap['Grande'],
      color: colorMap['Grande'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: mainDiffConst + 2,
      name: 'Bus',
      type: 'SPECIAL' as const,
      icon: getIconUrl('Bus'),
      legacyIcon: getLegacyIconUrl('101'),
      baseScore: 0,
      sortOrder: mainDiffConst + 2,
      legacy: '101',
      legacyEmoji: legacyEmojiMap['101'],
      emoji: emojiMap['Bus'],
      color: colorMap['Bus'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: mainDiffConst + 3,
      name: 'MA',
      type: 'SPECIAL' as const,
      icon: getIconUrl('MA'),
      legacyIcon: getLegacyIconUrl('102'),
      baseScore: 0,
      sortOrder: mainDiffConst + 3,
      legacy: '102',
      legacyEmoji: legacyEmojiMap['102'],
      emoji: emojiMap['MA'],
      color: colorMap['MA'],
      createdAt: new Date(),
      updatedAt: new Date(),
    }
  ];

  // Create Q ratings
  const qRatings = [
    {
      id: qDiffConst + 1,
      name: 'Q1+',
      type: 'SPECIAL' as const,
      icon: getIconUrl('Q1+'),
      legacyIcon: null,
      baseScore: 0,
      sortOrder: qDiffConst + 1,
      legacy: '103',
      legacyEmoji: null,
      emoji: emojiMap['Q1+'],
      color: colorMap['Q1+'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: qDiffConst + 2,
      name: 'Q2',
      type: 'SPECIAL' as const,
      icon: getIconUrl('Q2'),
      legacyIcon: null,
      baseScore: 0,
      sortOrder: qDiffConst + 2,
      legacy: '104',
      legacyEmoji: null,
      emoji: emojiMap['Q2'],
      color: colorMap['Q2'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: qDiffConst + 3,
      name: 'Q2+',
      type: 'SPECIAL' as const,
      icon: getIconUrl('Q2+'),
      legacyIcon: null,
      baseScore: 0,
      sortOrder: qDiffConst + 3,
      legacy: '105',
      legacyEmoji: null,
      emoji: emojiMap['Q2+'],
      color: colorMap['Q2+'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: qDiffConst + 4,
      name: 'Q3',
      type: 'SPECIAL' as const,
      icon: getIconUrl('Q3'),
      legacyIcon: null,
      baseScore: 0,
      sortOrder: qDiffConst + 4,
      legacy: '106',
      legacyEmoji: null,
      emoji: emojiMap['Q3'],
      color: colorMap['Q3'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: qDiffConst + 5,
      name: 'Q3+',
      type: 'SPECIAL' as const,
      icon: getIconUrl('Q3+'),
      legacyIcon: null,
      baseScore: 0,
      sortOrder: qDiffConst + 5,
      legacy: '107',
      legacyEmoji: null,
      emoji: emojiMap['Q3+'],
      color: colorMap['Q3+'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: qDiffConst + 6,
      name: 'Q4',
      type: 'SPECIAL' as const,
      icon: getIconUrl('Q4'),
      legacyIcon: null,
      baseScore: 0,
      sortOrder: qDiffConst + 6,
      legacy: '108',
      legacyEmoji: null,
      emoji: emojiMap['Q4'],
      color: colorMap['Q4'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: qDiffConst + 100,
      name: 'Qq',
      type: 'SPECIAL' as const,
      icon: getIconUrl('Qq'),
      legacyIcon: null,
      baseScore: 0,
      sortOrder: qDiffConst + 100,
      legacy: '109',
      legacyEmoji: null,
      emoji: emojiMap['Qq'],
      color: colorMap['Qq'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
        
    {
      id: qDiffConst+101,
      name: '-21',
      type: 'SPECIAL' as const,
      icon: getIconUrl('-21'),
      legacyIcon: getLegacyIconUrl('-21'),
      baseScore: 0,
      sortOrder: qDiffConst+101,
      legacy: '-21',
      legacyEmoji: legacyEmojiMap['-21'],
      emoji: emojiMap['-21'],
      color: colorMap['-21'],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  // Create P ratings
  const pRatings = Array.from({ length: 20 }, (_, i) => {
    const name = `P${i + 1}`;
    return {
      id: i + 1,
      name,
      type: 'PGU' as const,
      icon: getIconUrl(name),
      legacyIcon: getLegacyIconUrl(legacyMap[name as keyof typeof legacyMap]),
      baseScore: calculateBaseScore(i + 1),
      sortOrder: i + 1,
      legacy: legacyMap[name as keyof typeof legacyMap],
      legacyEmoji: legacyEmojiMap[legacyMap[name as keyof typeof legacyMap]],
      emoji: emojiMap[name],
      color: colorMap[name],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });

  // Create G ratings
  const gRatings = Array.from({ length: 20 }, (_, i) => {
    const name = `G${i + 1}`;
    return {
      id: i + 21,
      name,
      type: 'PGU' as const,
      icon: getIconUrl(name),
      legacyIcon: getLegacyIconUrl(legacyMap[name as keyof typeof legacyMap]),
      baseScore: calculateBaseScore(i + 21),
      sortOrder: i + 21,
      legacy: legacyMap[name as keyof typeof legacyMap],
      legacyEmoji: legacyEmojiMap[legacyMap[name as keyof typeof legacyMap]],
      emoji: emojiMap[name],
      color: colorMap[name],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });

  // Create U ratings
  const uRatings = Array.from({ length: 20 }, (_, i) => {
    const name = `U${i + 1}`;
    return {
      id: i + 41,
      name,
      type: 'PGU' as const,
      icon: getIconUrl(name),
      legacyIcon: getLegacyIconUrl(legacyMap[name as keyof typeof legacyMap]),
      baseScore: calculateBaseScore(i + 41),
      sortOrder: i + 41,
      legacy: legacyMap[name as keyof typeof legacyMap],
      legacyEmoji: legacyEmojiMap[legacyMap[name as keyof typeof legacyMap]],
      emoji: emojiMap[name],
      color: colorMap[name],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });

  // Combine all ratings
  const difficulties = [
    ...specialRatings,
    ...qRatings,
    ...pRatings,
    ...gRatings,
    ...uRatings
  ];
  // Only cache icons if transaction is provided
  if (transaction) {
    const processedDifficulties = await Promise.all(
      difficulties.map(async (diff) => {
        try {
          const newDiff = {
            ...diff,
            icon: await cacheIcon(diff.icon, diff.name),
            legacyIcon: diff.legacyIcon ? await cacheIcon(diff.legacyIcon, `legacy_${diff.name}`) : null
          };
          return newDiff;
        } catch (error) {
          console.error(`Failed to cache icons for ${diff.name}:`, error);
          return diff;
        }
      })
    );
    return processedDifficulties;
  }

  return difficulties;
};

// Export the initial map without caching for regular use
export const difficultyMap = await initializeDifficultyMap();
