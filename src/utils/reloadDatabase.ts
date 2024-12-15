import axios from 'axios';
import db from '../models/index';
import xlsx from 'xlsx';
import {calcAcc} from '../misc/CalcAcc';
import {getScoreV2} from '../misc/CalcScore';
import {difficultyMap} from './difficultyMap';
import {calculatePGUDiffNum} from './ratingUtils';
import {getBaseScore} from './parseBaseScore';
import {ILevel} from '../interfaces/models';

const BE_API = 'http://be.t21c.kro.kr';

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
  isLegacyPass: boolean;
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

// Add this before the reloadDatabase function
const levelIdMapping = new Map<number, number>();

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
    song: 'Placeholder',
    artist: 'Placeholder',
    creator: 'Placeholder',
    charter: 'Placeholder',
    vfxer: '',
    team: '',
    diffId: 0, // Unranked difficulty
    baseScore: 0,
    isCleared: false,
    clears: 0,
    vidLink: '',
    dlLink: '',
    workshopLink: '',
    publicComments: 'Placeholder level for missing ID',
    toRate: false,
    rerateReason: '',
    rerateNum: '',
    toBeChangedDiff: null,
    isDeleted: true,
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
  };
}

async function reloadDatabase() {
  const transaction = await db.sequelize.transaction();

  try {
    console.log('Starting database reload...');

    // Clear existing data in correct order (children before parents)
    await Promise.all([
      db.models.RatingDetail.destroy({where: {}, transaction}),
      db.models.Rating.destroy({where: {}, transaction}),
      db.models.Judgement.destroy({where: {}, transaction}),
      db.models.Pass.destroy({where: {}, transaction}),
      db.models.Level.destroy({where: {}, transaction}),
      db.models.Player.destroy({where: {}, transaction}),
      db.models.Difficulty.destroy({where: {}, transaction}),
    ]);

    // Clear tables with foreign key dependencies in order

    console.log('Cleared existing data');

    // Process difficulties
    const difficultyDocs = difficultyMap.map(diff => ({
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
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    // Replace the direct bulkCreate with our new docs array
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

    // Process players
    const players = Array.isArray(playersResponse)
      ? playersResponse
      : (playersResponse as any).results || [];
    const playerDocs = players
      .filter((player: RawPlayer) => player.name)
      .map((player: RawPlayer, index: number) => ({
        id: index + 1,
        name: player.name,
        country: player.country || 'XX',
        isBanned: player.isBanned || false,
      }));

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
    const levelDocs = [];
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
        const directMatch = difficultyMap.find(
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
            oldDiffToPGUMap[level.newDiff as keyof typeof oldDiffToPGUMap];
          if (mappedPGU) {
            const mappedMatch = difficultyMap.find(
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

      levelDocs.push({
        id: level.id,
        song: level.song || '',
        artist: level.artist || '',
        creator: level.creator || '',
        charter: level.charter || '',
        vfxer: level.vfxer || '',
        team: level.team || '',
        diffId,
        baseScore,
        isCleared: level.isCleared || false,
        clears: level.clears || 0,
        vidLink: level.vidLink || '',
        dlLink: level.dlLink || '',
        workshopLink: level.workshopLink || '',
        publicComments: level.publicComments || '',
        toRate: false,
        rerateReason: '',
        rerateNum: '',
        isDeleted: false,
      });

      nextLevelId = level.id + 1;
      levelIdMapping.set(level.id, level.id);
    }

    console.log(
      `Processed ${levelDocs.length} levels (including ${levelDocs.length - levels.length} placeholders)`,
    );

    // Create ID mappings
    const playerNameToId = new Map<string, number>(
      playerDocs.map((p: any) => [p.name, p.id]),
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

    for (const pass of passes) {
      const playerId = playerNameToId.get(pass.player);
      const newLevelId = levelIdMapping.get(pass.levelId);

      if (playerId && typeof newLevelId === 'number') {
        // Fill any gaps with placeholder judgements
        while (nextJudgementId < pass.id) {
          judgementDocs.push(createPlaceholderJudgement(nextJudgementId));
          nextJudgementId++;
        }

        // Create judgements object
        const judgements = {
          id: pass.id,
          earlyDouble: Number(pass.judgements[0]) || 0,
          earlySingle: Number(pass.judgements[1]) || 0,
          ePerfect: Number(pass.judgements[2]) || 0,
          perfect: Number(pass.judgements[3]) || 0,
          lPerfect: Number(pass.judgements[4]) || 0,
          lateSingle: Number(pass.judgements[5]) || 0,
          lateDouble: Number(pass.judgements[6]) || 0,
        };

        // Get the level's base score
        const level = levelDocs.find((l: any) => l.id === newLevelId);
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
          vidLink: pass.vidLink,
          vidUploadTime: new Date(pass.vidUploadTime),
          is12K: pass.is12K,
          is16K: false,
          isNoHoldTap: pass.isNoHoldTap,
          isLegacyPass: pass.isLegacyPass,
          isWorldsFirst,
          accuracy,
          scoreV2,
          isDeleted: false,
        });

        judgementDocs.push(judgements);
        nextJudgementId = pass.id + 1;
      }
    }

    // Bulk insert data in the correct order
    await db.models.Player.bulkCreate(playerDocs, {transaction});
    await db.models.Level.bulkCreate(levelDocs, {transaction});
    await db.models.Pass.bulkCreate(passDocs, {transaction});

    // Create judgements only for existing passes
    const existingPassIds = passDocs.map(pass => pass.id);
    const validJudgementDocs = judgementDocs.filter(judgement =>
      existingPassIds.includes(judgement.id),
    );

    await db.models.Judgement.bulkCreate(validJudgementDocs, {transaction});

    // Update clear counts
    const clearCounts = new Map<number, number>();
    const nonBannedPlayerIds = new Set(
      playerDocs.filter((p: any) => !p.isBanned).map((p: any) => p.id),
    );

    passDocs.forEach((pass: any) => {
      if (nonBannedPlayerIds.has(pass.playerId)) {
        clearCounts.set(pass.levelId, (clearCounts.get(pass.levelId) || 0) + 1);
      }
    });

    await Promise.all(
      Array.from(clearCounts.entries()).map(([levelId, clears]) =>
        db.models.Level.update({clears}, {where: {id: levelId}, transaction}),
      ),
    );

    // Commit transaction first
    await transaction.commit();
    console.log('Database reload completed successfully');

    return true;
  } catch (error) {
    await transaction.rollback();
    console.error('Database reload failed:', error);
    throw error;
  }
}

export default reloadDatabase;
