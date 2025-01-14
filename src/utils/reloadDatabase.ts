import axios from 'axios';
import db from '../models/index';
import xlsx from 'xlsx';
import {calcAcc} from '../misc/CalcAcc';
import {getScoreV2} from '../misc/CalcScore';
import {difficultyMap} from './difficultyMap';
import {initializeReferences} from './referenceMap';
import {calculatePGUDiffNum} from './ratingUtils';
import {getBaseScore} from './parseBaseScore';
import {ILevel} from '../interfaces/models';
import { initializeDifficultyMap } from './difficultyMap';
import { migrateCredits, migrateNewCredits } from './migrateCredits';
import { Transaction } from 'sequelize';

const BE_API = 'http://be.t21c.kro.kr';
const PLACEHOLDER = "" + process.env.PLACEHOLDER_PREFIX + process.env.PLACEHOLDER_BODY + process.env.PLACEHOLDER_POSTFIX;

interface RawLevel {
  id: number;
  song: string;
  artist: string;
  creator: string;
  charter: string;
  vfxer: string;
  team: string;
  legacyDiff: number;
  pguDiff: string;
  pguDiffNum: number;
  pdnDiff: number;
  newDiff: string;
  realDiff: number;
  baseScore: number;
  isCleared: boolean;
  clears: number;
  vidLink: string;
  dlLink: string;
  workshopLink: string;
  publicComments: string;
}

interface RawPass {
  id: number;
  levelId: number;
  speed: number | null;
  player: string;
  feelingRating: string;
  vidTitle: string;
  vidLink: string;
  vidUploadTime: string;
  is12K: boolean;
  isNoHoldTap: boolean;
  judgements: number[];
  accuracy: number;
  scoreV2: number;
  isWorldsFirst: boolean;
}

interface RawPlayer {
  name: string;
  country: string;
  isBanned: boolean;
}

interface LevelDoc {
  id: number;
  song: string;
  artist: string;
  creator: string;
  charter: string;
  vfxer: string;
  team: string;
  teamId: null;
  diffId: number;
  baseScore: number | null;
  isCleared: boolean;
  clears: number;
  videoLink: string;
  dlLink: string;
  workshopLink: string;
  publicComments: string;
  toRate: boolean;
  rerateReason: string;
  rerateNum: string;
  isDeleted: boolean;
  isAnnounced: boolean;
  previousDiffId: number;
  isHidden: boolean;
  isVerified: boolean;
  difficulty?: {
    baseScore: number;
  };
}

// Add this before the reloadDatabase function
const levelIdMapping = new Map<number, number>();

// Add interface for Player model
interface PlayerModel {
  id: number;
  name: string;
  country: string;
  isBanned: boolean;
}

// Add interface for Pass document
interface PassDoc {
  id: number;
  levelId: number;
  playerId: number;
  [key: string]: any;
}

async function fetchData<T>(endpoint: string): Promise<T> {
  try {
    const response = await axios.get(`${BE_API}${endpoint}`);
    return response.data;
  } catch (error) {
    console.error(`Error fetching data from ${endpoint}:`, error);
    throw error;
  }
}

async function readFeelingRatingsFromXlsx(): Promise<Map<number, string>> {
  try {
    const workbook = xlsx.readFile('./cache/passes.xlsx');
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rawData = xlsx.utils.sheet_to_json(worksheet);

    const feelingRatings = new Map<number, string>();

    rawData.forEach((row: any) => {
      const id = parseInt(row['Pid']);
      const rating = row['Feeling Difficulty']?.toString() || '';
      if (id !== 0 && !isNaN(id) && rating !== '') {
        feelingRatings.set(id, rating);
      }
    });

    console.log(`Loaded ${feelingRatings.size} feeling ratings from XLSX`);
    return feelingRatings;
  } catch (error) {
    console.error('Error reading feeling ratings from XLSX:', error);
    return new Map(); // Return empty map on error
  }
}

// Create a reverse mapping of base scores to PGU ratings
const baseScoreToPguMap = {
  0.1: 'P1',
  0.2: 'P2',
  0.3: 'P3',
  0.4: 'P4',
  0.5: 'P5',
  0.6: 'P6',
  0.7: 'P7',
  0.8: 'P8',
  0.9: 'P9',
  1: 'P10',
  2: 'P11',
  3: 'P12',
  5: 'P13',
  10: 'P14',
  15: 'P15',
  20: 'P16',
  30: 'P17',
  45: 'P18',
  60: 'P19',
  75: 'P20',
  100: 'G1',
  110: 'G2',
  120: 'G3',
  130: 'G4',
  140: 'G5',
  150: 'G6',
  160: 'G7',
  170: 'G8',
  180: 'G9',
  190: 'G10',
  200: 'G11',
  210: 'G12',
  220: 'G13',
  230: 'G14',
  240: 'G15',
  250: 'G16',
  275: 'G17',
  300: 'G18',
  350: 'G19',
  400: 'G20',
  500: 'U1',
  600: 'U2',
  700: 'U3',
  850: 'U4',
  1000: 'U5',
  1300: 'U6',
  1600: 'U7',
  1800: 'U8',
  2000: 'U9',
  2500: 'U10',
  3000: 'U11',
  4000: 'U12',
  5000: 'U13',
  11000: 'U14',
};

const oldDiffToPGUMap = {
  61: 'Qq',
  62: 'Q2',
  63: 'Q2p',
  64: 'Q3',
  65: 'Q3p',
  66: 'Q4',
  [-2]: '-2',
  [-21]: '-21',
  [-22]: '-22',
  100: 'Grande',
  101: 'Bus',
  102: 'MA',
};

function getBaseScorePguRating(baseScore: number): string {
  return (
    baseScoreToPguMap[baseScore as keyof typeof baseScoreToPguMap] ||
    baseScore.toString()
  );
}

function createPlaceholderLevel(id: number) {
  return {
    id,
    song: PLACEHOLDER,
    artist: PLACEHOLDER,
    creator: PLACEHOLDER,
    charter: PLACEHOLDER,
    vfxer: "",
    team: "",
    teamId: null,
    diffId: 1000,
    baseScore: 0,
    isCleared: false,
    clears: 0,
    videoLink: '',
    dlLink: '',
    workshopLink: '',
    publicComments: 'Placeholder level for missing ID',
    toRate: false,
    rerateReason: '',
    rerateNum: '',
    isDeleted: true,
    isAnnounced: true,
    isVerified: true,
    previousDiffId: 0,
    isHidden: false,
  };
}
// Add this helper function for creating placeholder judgements
function createPlaceholderJudgement(id: number) {
  return {
    id,
    earlyDouble: 0,
    earlySingle: 0,
    ePerfect: 0,
    perfect: 0,
    lPerfect: 0,
    lateSingle: 0,
    lateDouble: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function getOrCreatePlayers(players: RawPlayer[], transaction: Transaction) {
  // Get existing players
  const existingPlayers = await db.models.Player.findAll({
    attributes: ['id', 'name', 'country', 'isBanned'],
    transaction
  }) as PlayerModel[];

  const existingPlayersByName = new Map(existingPlayers.map(p => [p.name.toLowerCase(), p]));
  const newPlayers = [];

  // Process each player from the API
  for (const player of players) {
    if (!player.name) continue;

    const existingPlayer = existingPlayersByName.get(player.name.toLowerCase());
    if (!existingPlayer) {
      newPlayers.push({
        name: player.name,
        country: player.country || 'XX',
        isBanned: player.isBanned || false,
      });
    }
  }

  // Create new players if any
  let createdPlayers: PlayerModel[] = [];
  if (newPlayers.length > 0) {
    createdPlayers = await db.models.Player.bulkCreate(newPlayers, {
      transaction
    });
    console.log(`Created ${newPlayers.length} new players`);
  }

  // Return all players (existing + new) as a name-to-id map
  const allPlayers = [...existingPlayers, ...createdPlayers];
  return new Map(allPlayers.map(p => [p.name, p.id]));
}

async function reloadDatabase() {
  const transaction = await db.sequelize.transaction();

  try {
    console.log('Starting database reload...');

    // Initialize difficulty map with cached icons and transaction
    console.log('Initializing difficulties with icon caching...');
    const difficultyMapWithIcons = await initializeDifficultyMap(transaction);

    // Clear existing data in correct order
    console.log('Clearing existing data...');
    
    await Promise.all([
      db.models.RatingDetail.destroy({where: {}, transaction}),
      db.models.Rating.destroy({where: {}, transaction}),
      db.models.Judgement.destroy({where: {}, transaction}),
      db.models.Pass.destroy({where: {}, transaction}),
      db.models.TeamMember.destroy({where: {}, transaction}),
      db.models.LevelCredit.destroy({where: {}, transaction}),
      db.models.Level.destroy({where: {}, transaction}),
      db.models.Creator.destroy({where: {}, transaction}),
      db.models.Team.destroy({where: {}, transaction}),
      db.models.Player.destroy({where: {}, transaction}),
      db.models.Difficulty.destroy({where: {}, transaction}),
    ]);

    // Process difficulties with cached icons
    const difficultyDocs = difficultyMapWithIcons.map(diff => ({
      id: diff.id,
      name: diff.name,
      type: diff.type,
      icon: diff.icon,
      baseScore: diff.baseScore,
      sortOrder: diff.sortOrder,
      legacy: diff.legacy,
      legacyIcon: diff.legacyIcon,
      emoji: diff.emoji,
      legacyEmoji: diff.legacyEmoji,
      color: diff.color,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    console.log(`Creating ${difficultyDocs.length} difficulty entries...`);
    await db.models.Difficulty.bulkCreate(difficultyDocs, {transaction});
    console.log('Populated difficulties table');

    // Load data from BE API
    const [playersResponse, levelsResponse, passesResponse] = await Promise.all(
      [
        fetchData<RawPlayer[]>('/players'),
        fetchData<RawLevel[]>('/levels'),
        fetchData<{count: number; results: RawPass[]}>('/passes'),
      ],
    );

    // Process players from API
    const playersFromApi = Array.isArray(playersResponse)
      ? playersResponse
      : (playersResponse as any).results || [];

    const playerNameToId = await getOrCreatePlayers(playersFromApi, transaction);

    // Process levels
    const levels = Array.isArray(levelsResponse)
      ? levelsResponse
      : (levelsResponse as any).results || [];

    // Sort levels by ID and create ID mapping
    levels.sort((a: any, b: any) => a.id - b.id);
    levels.forEach((level: RawLevel) => {
      levelIdMapping.set(level.id, level.id); // Map old ID to new ID
    });

    // Process levels with placeholders
    const levelDocs: LevelDoc[] = [];
    let nextLevelId = 1;

    for (const level of levels) {
      // Fill gaps with placeholders
      while (level.id > nextLevelId) {
        levelDocs.push(createPlaceholderLevel(nextLevelId));
        nextLevelId++;
      }

      // Process actual level
      let diffId = 0; // Default to unranked
      let baseScore = null;

      if (level.pguDiff) {
        // Try direct match from pguDiff to difficultyMap
        const directMatch = difficultyMapWithIcons.find(
          d =>
            d.name.toLowerCase() === String(level.pguDiff).toLowerCase() ||
            d.name.toLowerCase().replace('+', 'p') ===
              String(level.pguDiff).toLowerCase(),
        );

        if (directMatch) {
          diffId = directMatch.id;
          // Only set baseScore if it differs from difficulty's baseScore
          baseScore =
            level.baseScore === directMatch.baseScore ? null : level.baseScore;
        } else {
          // Try oldDiffToPGUMap
          const mappedPGU =
            oldDiffToPGUMap[Number(level.newDiff) as keyof typeof oldDiffToPGUMap];
          if (mappedPGU) {
            const mappedMatch = difficultyMapWithIcons.find(
              d =>
                d.name.toLowerCase() === String(mappedPGU).toLowerCase() ||
                d.name.toLowerCase().replace('+', 'p') ===
                  String(mappedPGU).toLowerCase(),
            );
            if (mappedMatch) {
              diffId = mappedMatch.id;
              // Only set baseScore if it differs from difficulty's baseScore
              baseScore =
                level.baseScore === mappedMatch.baseScore
                  ? null
                  : level.baseScore;
            }
          }
        }
      }

      // Check if credits are simple (no brackets or parentheses)
      const complexChars = ['[', '(', '{', '}', ']', ')'];
      const hasSimpleCredits = !complexChars.some(char => 
        level.creator.includes(char) || 
        level.charter.includes(char) || 
        level.vfxer.includes(char)
      );

      levelDocs.push({
        id: level.id,
        song: level.song || '',
        artist: level.artist || '',
        creator: level.creator || '',
        charter: level.charter || '',
        vfxer: level.vfxer || '',
        team: level.team || '',
        teamId: null, // Will be set during credit migration
        diffId,
        baseScore,
        isCleared: level.isCleared || false,
        clears: level.clears || 0,
        videoLink: level.vidLink || '',
        dlLink: level.dlLink || '',
        workshopLink: level.workshopLink || '',
        publicComments: level.publicComments || '',
        toRate: false,
        rerateReason: '',
        rerateNum: '',
        isDeleted: false,
        isAnnounced: true,
        previousDiffId: 0,
        isHidden: false,
        isVerified: hasSimpleCredits // Auto-verify levels with simple credits
      });
      

      nextLevelId = level.id + 1;
      levelIdMapping.set(level.id, level.id);
    }

    console.log(
      `Processed ${levelDocs.length} levels (including ${levelDocs.length - levels.length} placeholders)`,
    );

    // Load feeling ratings
    const feelingRatings = await readFeelingRatingsFromXlsx();

    // Process passes and judgements
    const passes = passesResponse.results;
    const passDocs = [];
    const judgementDocs = [];
    let nextJudgementId = 1;

    // First, organize passes by level to determine world's firsts
    const levelFirstPasses = new Map<number, {uploadTime: Date; id: number}>();
    passes.forEach((pass: RawPass) => {
      const newLevelId = levelIdMapping.get(pass.levelId);
      if (typeof newLevelId !== 'number') return;

      const uploadTime = new Date(pass.vidUploadTime);
      const currentFirst = levelFirstPasses.get(newLevelId);

      if (!currentFirst || uploadTime < currentFirst.uploadTime) {
        levelFirstPasses.set(newLevelId, {uploadTime, id: pass.id});
      }
    });

    // Sort passes by ID to process them in order
    passes.sort((a, b) => a.id - b.id);

    let lastValidUploadTime = new Date('2000-01-01 00:00:00'); // Default fallback

    for (const pass of passes) {
      const playerId = playerNameToId.get(pass.player);
      const newLevelId = levelIdMapping.get(pass.levelId);

      if (playerId && typeof newLevelId === 'number') {
        // Update lastValidUploadTime if this pass has a valid upload time
        if (pass.vidUploadTime) {
          const uploadTime = new Date(pass.vidUploadTime);
          if (uploadTime instanceof Date && !isNaN(uploadTime.getTime())) {
            lastValidUploadTime = uploadTime;
          }
        }

        // Fill any gaps with placeholder judgements
        while (nextJudgementId < pass.id) {
          judgementDocs.push(createPlaceholderJudgement(nextJudgementId));
          nextJudgementId++;
        }

        // Create judgements object
        // Check if all judgements are integers
        if (pass.judgements.some(j => !Number.isInteger(j))) {
          pass.judgements[0] = 0;
          pass.judgements[1] = 0;
          pass.judgements[2] = 5;
          pass.judgements[3] = 40;
          pass.judgements[4] = 5; 
          pass.judgements[5] = 0;
          pass.judgements[6] = 0;
        }
        
        const judgements = {
          id: pass.id,
          earlyDouble: Number(pass.judgements[0]) || 0,
          earlySingle: Number(pass.judgements[1]) || 0,
          ePerfect: Number(pass.judgements[2]) || 0,
          perfect: Number(pass.judgements[3]) || 0,
          lPerfect: Number(pass.judgements[4]) || 0,
          lateSingle: Number(pass.judgements[5]) || 0,
          lateDouble: Number(pass.judgements[6]) || 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        // Get the level's base score
        const level = levelDocs.find((l: LevelDoc) => l.id === newLevelId);
        const difficulty = difficultyDocs.find(d => d.id === level?.diffId);
        const baseScore = level?.baseScore || difficulty?.baseScore || 0;

        // Calculate accuracy and score
        const accuracy = calcAcc(judgements);
        const scoreV2 = getScoreV2(
          {
            speed: pass.speed || 1,
            judgements,
            isNoHoldTap: pass.isNoHoldTap,
          },
          {
            baseScore,
          },
        );

        // Check if this pass is the world's first for its level
        const isWorldsFirst = levelFirstPasses.get(newLevelId)?.id === pass.id;

        passDocs.push({
          id: pass.id,
          levelId: newLevelId,
          playerId: playerId,
          speed: pass.speed || 1,
          feelingRating:
            feelingRatings.get(pass.id)?.toString() || pass.feelingRating,
          vidTitle: pass.vidTitle,
          videoLink: pass.vidLink,
          vidUploadTime: pass.vidUploadTime ? new Date(pass.vidUploadTime) : lastValidUploadTime,
          is12K: pass.is12K,
          is16K: false,
          isNoHoldTap: pass.isNoHoldTap,
          isWorldsFirst,
          accuracy,
          scoreV2,
          isAnnounced: true,
          isDeleted: false,
          isHidden: false,
        });

        judgementDocs.push(judgements);
        nextJudgementId = pass.id + 1;
      }
    }

    // Bulk insert data in the correct order
    await db.models.Level.bulkCreate(levelDocs as any, {transaction});
    await db.models.Pass.bulkCreate(passDocs as any, {transaction});
    
    // Initialize references and migrate credits (which now includes team handling)
    await initializeReferences(difficultyDocs, transaction);
    await migrateCredits(levelDocs as any, transaction);
    
    // Create judgements only for existing passes
    const existingPassIds = passDocs.map(pass => pass.id);
    const validJudgementDocs = judgementDocs.filter(judgement =>
      existingPassIds.includes(judgement.id),
    );

    await db.models.Judgement.bulkCreate(validJudgementDocs, {transaction});

    // Update clear counts
    const clearCounts = new Map<number, number>();
    const existingPlayers = await db.models.Player.findAll({
      attributes: ['id', 'isBanned'],
      transaction
    }) as PlayerModel[];
    const nonBannedPlayerIds = new Set(
      existingPlayers.filter(p => !p.isBanned).map(p => p.id)
    );

    passDocs.forEach((pass: PassDoc) => {
      if (nonBannedPlayerIds.has(pass.playerId)) {
        clearCounts.set(pass.levelId, (clearCounts.get(pass.levelId) || 0) + 1);
      }
    });

    await Promise.all(
      Array.from(clearCounts.entries()).map(([levelId, clears]) =>
        db.models.Level.update({clears}, {where: {id: levelId}, transaction}),
      ),
    );

    // After all other operations, before the final commit
    // Create ratings for unranked levels
    console.log('Creating ratings for unranked levels...');
    const unrankedLevels = await db.models.Level.findAll({
      where: { 
        diffId: 0,
        isDeleted: false,
        isHidden: false
      },
      transaction
    });

    const ratingDocs = unrankedLevels.map(level => ({
      levelId: level.id,
      currentDifficultyId: 0,
      lowDiff: /^[pP]\d/.test(level.rerateNum || ''),
      requesterFR: level.rerateNum || '',
      averageDifficultyId: null,
      createdAt: new Date(),
      updatedAt: new Date()
    }));

    if (ratingDocs.length > 0) {
      await db.models.Rating.bulkCreate(ratingDocs, { transaction });
      // Update toRate flag for these levels
      await db.models.Level.update(
        { toRate: true },
        {
          where: { id: unrankedLevels.map(l => l.id) },
          transaction
        }
      );
      console.log(`Created ${ratingDocs.length} rating objects for unranked levels`);
    }

    await transaction.commit();
    console.log('Database reload completed successfully');

    return true;
  } catch (error) {
    await transaction.rollback();
    console.error('Error during database reload:', error);
    throw error;
  }
}

export async function partialReload() {
  const transaction = await db.sequelize.transaction();

  try {
    console.log('Starting partial database reload...');

    // Initialize difficulty map with cached icons and transaction
    console.log('Initializing difficulties with icon caching...');
    const difficultyMapWithIcons = await initializeDifficultyMap(transaction);

    // Load data from BE API
    const [levelsResponse, passesResponse] = await Promise.all([
      fetchData<RawLevel[]>('/levels'),
      fetchData<{count: number; results: RawPass[]}>('/passes'),
    ]);

    // Get existing levels and passes
    const existingLevels = await db.models.Level.findAll({
      attributes: ['id'],
      transaction
    });
    const existingPasses = await db.models.Pass.findAll({
      attributes: ['id'],
      transaction
    });

    const existingLevelIds = new Set(existingLevels.map(l => l.id));
    const existingPassIds = new Set(existingPasses.map(p => p.id));

    // Process levels
    const levels = Array.isArray(levelsResponse)
      ? levelsResponse
      : (levelsResponse as any).results || [];

    // Filter out existing levels
    const newLevels = levels.filter((level: RawLevel) => !existingLevelIds.has(level.id));
    console.log(`Found ${newLevels.length} new levels to add`);

    // Process new levels
    const levelDocs: LevelDoc[] = [];
    for (const level of newLevels as RawLevel[]) {
      let diffId = 0; // Default to unranked
      let baseScore = null;

      if (level.pguDiff) {
        const directMatch = difficultyMapWithIcons.find(
          d =>
            d.name.toLowerCase() === String(level.pguDiff).toLowerCase() ||
            d.name.toLowerCase().replace('+', 'p') ===
              String(level.pguDiff).toLowerCase(),
        );

        if (directMatch) {
          diffId = directMatch.id;
          baseScore =
            level.baseScore === directMatch.baseScore ? null : level.baseScore;
        } else {
          const mappedPGU =
            oldDiffToPGUMap[Number(level.newDiff) as keyof typeof oldDiffToPGUMap];
          if (mappedPGU) {
            const mappedMatch = difficultyMapWithIcons.find(
              d =>
                d.name.toLowerCase() === String(mappedPGU).toLowerCase() ||
                d.name.toLowerCase().replace('+', 'p') ===
                  String(mappedPGU).toLowerCase(),
            );
            if (mappedMatch) {
              diffId = mappedMatch.id;
              baseScore =
                level.baseScore === mappedMatch.baseScore
                  ? null
                  : level.baseScore;
            }
          }
        }
      }

      // Check if credits are simple (no brackets or parentheses)
      const complexChars = ['[', '(', '{', '}', ']', ')'];
      const hasSimpleCredits = !complexChars.some(char => 
        level.creator.includes(char) || 
        level.charter.includes(char) || 
        level.vfxer.includes(char)
      );

      levelDocs.push({
        id: level.id,
        song: level.song || '',
        artist: level.artist || '',
        creator: level.creator || '',
        charter: level.charter || '',
        vfxer: level.vfxer || '',
        team: level.team || '',
        teamId: null,
        diffId,
        baseScore,
        isCleared: level.isCleared || false,
        clears: level.clears || 0,
        videoLink: level.vidLink || '',
        dlLink: level.dlLink || '',
        workshopLink: level.workshopLink || '',
        publicComments: level.publicComments || '',
        toRate: false,
        rerateReason: '',
        rerateNum: '',
        isDeleted: false,
        isAnnounced: true,
        previousDiffId: 0,
        isHidden: false,
        isVerified: hasSimpleCredits
      });
    }

    // Process passes
    const passes = passesResponse.results;
    const newPasses = passes.filter(pass => !existingPassIds.has(pass.id));
    console.log(`Found ${newPasses.length} new passes to add`);

    // Get existing players for mapping
    const players = await db.models.Player.findAll({
      attributes: ['id', 'name'],
      transaction
    });
    const playerNameToId = new Map(players.map(p => [p.name, p.id]));

    // Load feeling ratings
    const feelingRatings = await readFeelingRatingsFromXlsx();

    // Process new passes
    const passDocs = [];
    const judgementDocs = [];
    let lastValidUploadTime = new Date('2000-01-01 00:00:00');

    // First, organize passes by level to determine world's firsts
    const levelFirstPasses = new Map<number, {uploadTime: Date; id: number}>();
    for (const pass of newPasses) {
      const uploadTime = new Date(pass.vidUploadTime);
      const currentFirst = levelFirstPasses.get(pass.levelId);

      if (!currentFirst || uploadTime < currentFirst.uploadTime) {
        levelFirstPasses.set(pass.levelId, {uploadTime, id: pass.id});
      }
    }

    for (const pass of newPasses) {
      const playerId = playerNameToId.get(pass.player);
      if (!playerId) {
        console.log(`Skipping pass ${pass.id} - player ${pass.player} not found`);
        continue;
      }

      if (pass.vidUploadTime) {
        const uploadTime = new Date(pass.vidUploadTime);
        if (uploadTime instanceof Date && !isNaN(uploadTime.getTime())) {
          lastValidUploadTime = uploadTime;
        }
      }

      // Create judgements object
      if (pass.judgements.some(j => !Number.isInteger(j))) {
        pass.judgements[0] = 0;
        pass.judgements[1] = 0;
        pass.judgements[2] = 5;
        pass.judgements[3] = 40;
        pass.judgements[4] = 5; 
        pass.judgements[5] = 0;
        pass.judgements[6] = 0;
      }
      
      const judgements = {
        id: pass.id,
        earlyDouble: Number(pass.judgements[0]) || 0,
        earlySingle: Number(pass.judgements[1]) || 0,
        ePerfect: Number(pass.judgements[2]) || 0,
        perfect: Number(pass.judgements[3]) || 0,
        lPerfect: Number(pass.judgements[4]) || 0,
        lateSingle: Number(pass.judgements[5]) || 0,
        lateDouble: Number(pass.judgements[6]) || 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Get the level's base score
      const level = levelDocs.find((l: LevelDoc) => l.id === pass.levelId) || 
                   await db.models.Level.findByPk(pass.levelId, {
                     include: [{
                       model: db.models.Difficulty,
                       as: 'difficulty'
                     }],
                     transaction
                   });
      const difficulty = level?.difficulty;
      const baseScore = level?.baseScore || difficulty?.baseScore || 0;

      // Calculate accuracy and score
      const accuracy = calcAcc(judgements);
      const scoreV2 = getScoreV2(
        {
          speed: pass.speed || 1,
          judgements,
          isNoHoldTap: pass.isNoHoldTap,
        },
        {
          baseScore,
        },
      );

      // Check if this pass is the world's first for its level
      const isWorldsFirst = levelFirstPasses.get(pass.levelId)?.id === pass.id;

      passDocs.push({
        id: pass.id,
        levelId: pass.levelId,
        playerId: playerId,
        speed: pass.speed || 1,
        feelingRating:
          feelingRatings.get(pass.id)?.toString() || pass.feelingRating,
        vidTitle: pass.vidTitle,
        videoLink: pass.vidLink,
        vidUploadTime: pass.vidUploadTime ? new Date(pass.vidUploadTime) : lastValidUploadTime,
        is12K: pass.is12K,
        is16K: false,
        isNoHoldTap: pass.isNoHoldTap,
        isWorldsFirst,
        accuracy,
        scoreV2,
        isAnnounced: true,
        isDeleted: false,
        isHidden: false,
      });

      judgementDocs.push(judgements);
    }

    // Bulk create new data
    if (levelDocs.length > 0) {
      await db.models.Level.bulkCreate(levelDocs as any, {transaction});
      console.log(`Created ${levelDocs.length} new levels`);
    }

    if (passDocs.length > 0) {
      await db.models.Pass.bulkCreate(passDocs as any, {transaction});
      await db.models.Judgement.bulkCreate(judgementDocs, {transaction});
      console.log(`Created ${passDocs.length} new passes with judgements`);
    }

    // Process credits for new levels
    if (levelDocs.length > 0) {
      await migrateNewCredits(levelDocs as any, transaction);
    }

    // Update clear counts for affected levels
    const affectedLevelIds = new Set([
      ...newLevels.map((l: RawLevel) => l.id), 
      ...newPasses.map(p => p.levelId)
    ]);
    for (const levelId of affectedLevelIds) {
      const clearCount = await db.models.Pass.count({
        where: {
          levelId,
          isDeleted: false,
          '$player.isBanned$': false
        },
        include: [{
          model: db.models.Player,
          as: 'player',
          required: true
        }],
        transaction
      });

      await db.models.Level.update(
        {
          clears: clearCount,
          isCleared: clearCount > 0
        },
        {
          where: { id: levelId },
          transaction
        }
      );
    }

    // Create ratings for new unranked levels
    console.log('Creating ratings for new unranked levels...');
    const unrankedLevels = await db.models.Level.findAll({
      where: { 
        id: levelDocs.filter(l => l.diffId === 0).map(l => l.id),
        isDeleted: false,
        isHidden: false
      },
      transaction
    });

    if (unrankedLevels.length > 0) {
      const ratingDocs = unrankedLevels.map(level => ({
        levelId: level.id,
        currentDifficultyId: 0,
        lowDiff: /^[pP]\d/.test(level.rerateNum || ''),
        requesterFR: level.rerateNum || '',
        averageDifficultyId: null,
        createdAt: new Date(),
        updatedAt: new Date()
      }));

      await db.models.Rating.bulkCreate(ratingDocs, { transaction });
      
      // Update toRate flag for these levels
      await db.models.Level.update(
        { toRate: true },
        {
          where: { id: unrankedLevels.map(l => l.id) },
          transaction
        }
      );
      console.log(`Created ${ratingDocs.length} rating objects for new unranked levels`);
    }

    await transaction.commit();
    console.log('Partial database reload completed successfully');
    return true;
  } catch (error) {
    await transaction.rollback();
    console.error('Error during partial database reload:', error);
    throw error;
  }
}

export default reloadDatabase;
