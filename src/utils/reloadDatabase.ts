import db from '../models/index.js';
import xlsx from 'xlsx';
import {calcAcc} from '../misc/CalcAcc.js';
import {getScoreV2} from '../misc/CalcScore.js';
import {initializeReferences} from './referenceMap.js';
import {initializeDifficultyMap} from './difficultyMap.js';
import {migrateNewCredits} from './migrateCredits.js';
import {Transaction} from 'sequelize';
import cliProgress from 'cli-progress';
import colors from 'ansi-colors';
import fs from 'fs';
import axios from 'axios';

const BE_API = 'http://be.t21c.kro.kr';
const PLACEHOLDER =
  '' +
  process.env.PLACEHOLDER_PREFIX +
  process.env.PLACEHOLDER_BODY +
  process.env.PLACEHOLDER_POSTFIX;

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
  isSubmissionsPaused: boolean;
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

// Define progress bar format
const progressBar = new cliProgress.MultiBar(
  {
    format: colors.cyan('{bar}') + ' | {percentage}% | {task} | {subtask}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    clearOnComplete: true,
    noTTYOutput: !process.stdout.isTTY,
    stream: process.stdout,
    fps: 2,
    forceRedraw: false,
    stopOnComplete: true,
  },
  cliProgress.Presets.shades_classic,
);

async function fetchData<T>(endpoint: string): Promise<T> {
  const response = await axios.get(`${BE_API}${endpoint}`);
  return response.data;
}

async function readFeelingRatingsFromXlsx(): Promise<Map<number, string>> {
  const csvBar = progressBar.create(100, 0, {
    task: 'CSV Processing',
    subtask: 'Starting...',
  });

  try {
    const xlsxPath = './cache/passes.xlsx';
    const csvPath = './cache/passes.csv';

    if (fs.existsSync(csvPath)) {
      const content = fs.readFileSync(csvPath, 'utf8');
      const lines = content.split('\n');

      const feelingRatings = new Map<number, string>();

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const [pidStr, , feelingDiff] = line.split(',');
        const id = parseInt(pidStr);
        const rating = feelingDiff?.trim()?.replace(/^"|"$/g, '') || '';

        if (!isNaN(id) && id !== 0 && rating !== '') {
          feelingRatings.set(id, rating);
        }

        const progress = Math.floor((i / lines.length) * 100);
        csvBar.update(progress, {
          task: 'CSV Processing',
          subtask: `${i}/${lines.length} rows`,
        });
      }

      csvBar.update(100, {
        task: 'CSV Processing',
        subtask: 'Complete',
      });
      csvBar.stop();

      return feelingRatings;
    }

    if (!fs.existsSync(xlsxPath)) {
      return new Map();
    }

    try {
      fs.accessSync(xlsxPath, fs.constants.R_OK);
    } catch (e) {
      return new Map();
    }

    let workbook;
    try {
      workbook = xlsx.readFile(xlsxPath, {
        cellDates: true,
        cellNF: false,
        cellText: false,
      });
    } catch (e) {
      return new Map();
    }

    if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
      return new Map();
    }

    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      return new Map();
    }

    const rawData = xlsx.utils.sheet_to_json(worksheet);
    const feelingRatings = new Map<number, string>();

    rawData.forEach((row: any, index: number) => {
      const id = parseInt(row['Pid']);
      const rating = row['Feeling Difficulty']?.toString() || '';

      if (!isNaN(id) && id !== 0 && rating !== '') {
        feelingRatings.set(id, rating);
      }

      const progress = Math.floor((index / rawData.length) * 100);
      csvBar.update(progress, {
        task: 'CSV Processing',
        subtask: `${index}/${rawData.length} rows`,
      });
    });

    csvBar.update(100, {
      task: 'CSV Processing',
      subtask: 'Complete',
    });
    csvBar.stop();

    return feelingRatings;
  } catch (error) {
    return new Map();
  }
}

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

function createPlaceholderLevel(id: number) {
  return {
    id,
    song: PLACEHOLDER,
    artist: PLACEHOLDER,
    creator: PLACEHOLDER,
    charter: PLACEHOLDER,
    vfxer: '',
    team: '',
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

async function getOrCreatePlayers(
  players: RawPlayer[],
  transaction: Transaction,
) {
  // Get existing players
  const existingPlayers = (await db.models.Player.findAll({
    attributes: ['id', 'name', 'country', 'isBanned'],
    transaction,
  })) as PlayerModel[];

  const existingPlayersByName = new Map(
    existingPlayers.map(p => [p.name.toLowerCase(), p]),
  );
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
        isSubmissionsPaused: player.isSubmissionsPaused || false,
      });
    }
  }

  // Create new players if any
  let createdPlayers: PlayerModel[] = [];
  if (newPlayers.length > 0) {
    createdPlayers = await db.models.Player.bulkCreate(newPlayers, {
      transaction,
    });
  }

  // Return all players (existing + new) as a name-to-id map
  const allPlayers = [...existingPlayers, ...createdPlayers];
  return new Map(allPlayers.map(p => [p.name, p.id]));
}

async function reloadDatabase() {
  const transaction = await db.sequelize.transaction();

  const mainBar = progressBar.create(100, 0, {
    task: 'Database Reload',
    subtask: 'Initializing...',
  });

  try {
    let progress = 0;
    const updateProgress = (
      increment: number,
      task: string,
      subtask: string,
    ) => {
      progress = Math.min(100, progress + increment);
      mainBar.update(progress, {task, subtask});
    };

    updateProgress(0, 'Database Reload', 'Initializing difficulty map');
    const difficultyMapWithIcons = await initializeDifficultyMap(transaction);

    updateProgress(5, 'Database Cleanup', 'Clearing existing data');
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

    updateProgress(10, 'Difficulty Setup', 'Creating difficulty entries');
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
    await db.models.Difficulty.bulkCreate(difficultyDocs, {transaction});

    updateProgress(15, 'Data Fetching', 'Loading data from API');
    const [playersResponse, levelsResponse, passesResponse] = await Promise.all(
      [
        fetchData<RawPlayer[]>('/players'),
        fetchData<RawLevel[]>('/levels'),
        fetchData<{count: number; results: RawPass[]}>('/passes'),
      ],
    );

    updateProgress(25, 'Player Processing', 'Creating player mappings');
    const playersFromApi = Array.isArray(playersResponse)
      ? playersResponse
      : (playersResponse as any).results || [];
    const playerNameToId = await getOrCreatePlayers(
      playersFromApi,
      transaction,
    );

    updateProgress(35, 'Level Processing', 'Processing levels');
    const levels = Array.isArray(levelsResponse)
      ? levelsResponse
      : (levelsResponse as any).results || [];

    const levelDocs: LevelDoc[] = [];
    let nextLevelId = 1;
    let processedCount = 0;
    const totalLevels = levels.length;
    const updateInterval = Math.max(1, Math.floor(totalLevels / 20));

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
            oldDiffToPGUMap[
              Number(level.newDiff) as keyof typeof oldDiffToPGUMap
            ];
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
      const hasSimpleCredits = !complexChars.some(
        char =>
          level.creator.includes(char) ||
          level.charter.includes(char) ||
          level.vfxer.includes(char),
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
        isVerified: hasSimpleCredits, // Auto-verify levels with simple credits
      });

      nextLevelId = level.id + 1;
      levelIdMapping.set(level.id, level.id);

      processedCount++;
      if (processedCount % updateInterval === 0) {
        updateProgress(
          35 + (processedCount / totalLevels) * 15,
          'Level Processing',
          `Processed ${processedCount}/${totalLevels} levels`,
        );
      }
    }

    updateProgress(50, 'Pass Processing', 'Loading feeling ratings');
    const feelingRatings = await readFeelingRatingsFromXlsx();

    updateProgress(55, 'Pass Processing', 'Processing passes');
    const passes = passesResponse.results;
    const passDocs = [];
    const judgementDocs = [];
    let nextJudgementId = 1;
    processedCount = 0;
    const totalPasses = passes.length;
    const passUpdateInterval = Math.max(1, Math.floor(totalPasses / 20));

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

    let lastValidUploadTime = new Date('2000-01-01 00:00:00');

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
            isNoHoldTap: pass.isNoHoldTap || false,
            judgements: {
              earlyDouble: judgements.earlyDouble || 0,
              earlySingle: judgements.earlySingle || 0,
              ePerfect: judgements.ePerfect || 0,
              perfect: judgements.perfect || 0,
              lPerfect: judgements.lPerfect || 0,
              lateSingle: judgements.lateSingle || 0,
              lateDouble: judgements.lateDouble || 0,
            },
          },
          {
            baseScore: baseScore,
            difficulty: {
              baseScore: baseScore || 0,
            },
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
          vidUploadTime: pass.vidUploadTime
            ? new Date(pass.vidUploadTime)
            : lastValidUploadTime,
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

        processedCount++;
        if (processedCount % passUpdateInterval === 0) {
          updateProgress(
            55 + (processedCount / totalPasses) * 20,
            'Pass Processing',
            `Processed ${processedCount}/${totalPasses} passes`,
          );
        }
      }
    }

    updateProgress(75, 'Data Creation', 'Creating levels');
    const BATCH_SIZE = 4000;
    for (let i = 0; i < levelDocs.length; i += BATCH_SIZE) {
      const batch = levelDocs.slice(i, i + BATCH_SIZE);
      await db.models.Level.bulkCreate(batch as any, {transaction});
    }

    updateProgress(80, 'Data Creation', 'Creating passes');
    for (let i = 0; i < passDocs.length; i += BATCH_SIZE) {
      const batch = passDocs.slice(i, i + BATCH_SIZE);
      await db.models.Pass.bulkCreate(batch as any, {transaction});
    }

    updateProgress(85, 'Data Creation', 'Creating judgements');
    for (let i = 0; i < judgementDocs.length; i += BATCH_SIZE) {
      const batch = judgementDocs.slice(i, i + BATCH_SIZE);
      const passIds = batch.map(j => j.id);

      const existingPasses = await db.models.Pass.findAll({
        where: {id: passIds},
        attributes: ['id'],
        transaction,
      });
      const existingPassIds = new Set(existingPasses.map((p: any) => p.id));

      const validJudgements = batch.filter(j => existingPassIds.has(j.id));
      if (validJudgements.length > 0) {
        await db.models.Judgement.bulkCreate(validJudgements, {transaction});
      }
    }

    updateProgress(90, 'Finalizing', 'Updating clear counts');
    const clearCounts = new Map<number, number>();
    const existingPlayers = (await db.models.Player.findAll({
      attributes: ['id', 'isBanned'],
      transaction,
    })) as PlayerModel[];
    const nonBannedPlayerIds = new Set(
      existingPlayers
        .filter((p: PlayerModel) => !p.isBanned)
        .map((p: PlayerModel) => p.id),
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

    await initializeReferences(difficultyDocs, transaction);
    updateProgress(95, 'Finalizing', 'Creating ratings for unranked levels');
    const unrankedLevels = await db.models.Level.findAll({
      where: {
        diffId: 0,
        isDeleted: false,
        isHidden: false,
      },
      transaction,
    });

    const ratingDocs = unrankedLevels.map((level: any) => ({
      levelId: level.id,
      currentDifficultyId: 0,
      lowDiff: /^[pP]\d/.test(level.rerateNum || ''),
      requesterFR: level.rerateNum || '',
      averageDifficultyId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    if (ratingDocs.length > 0) {
      await db.models.Rating.bulkCreate(ratingDocs, {transaction});
      await db.models.Level.update(
        {toRate: true},
        {
          where: {id: unrankedLevels.map((l: any) => l.id)},
          transaction,
        },
      );
    }

    updateProgress(100, 'Complete', 'Committing transaction');
    await transaction.commit();
    progressBar.stop();
    return true;
  } catch (error) {
    progressBar.stop();
    await transaction.rollback();
    throw error;
  }
}

export async function partialReload() {
  const transaction = await db.sequelize.transaction();
  const mainBar = progressBar.create(100, 0, {
    task: 'Partial Database Reload',
    subtask: 'Initializing...',
  });

  try {
    let progress = 0;
    const updateProgress = (
      increment: number,
      task: string,
      subtask: string,
    ) => {
      progress = Math.min(100, progress + increment);
      mainBar.update(progress, {task, subtask});
    };

    updateProgress(0, 'Initializing', 'Setting up difficulty map');
    const difficultyMapWithIcons = await initializeDifficultyMap(transaction);

    updateProgress(20, 'Data Fetching', 'Loading from API');
    const [levelsResponse, passesResponse] = await Promise.all([
      fetchData<RawLevel[]>('/levels'),
      fetchData<{count: number; results: RawPass[]}>('/passes'),
    ]);

    updateProgress(30, 'Data Processing', 'Finding new data');
    const existingLevels = await db.models.Level.findAll({
      attributes: ['id'],
      transaction,
    });
    const existingPasses = await db.models.Pass.findAll({
      attributes: ['id'],
      transaction,
    });

    const existingLevelIds = new Set(existingLevels.map((l: any) => l.id));
    const existingPassIds = new Set(existingPasses.map((p: any) => p.id));

    const levels = Array.isArray(levelsResponse)
      ? levelsResponse
      : (levelsResponse as any).results || [];
    const newLevels = levels.filter(
      (level: RawLevel) => !existingLevelIds.has(level.id),
    );

    updateProgress(40, 'Level Processing', 'Processing new levels');
    const levelDocs: LevelDoc[] = [];
    for (const level of newLevels as RawLevel[]) {
      let diffId = 0;
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
            oldDiffToPGUMap[
              Number(level.newDiff) as keyof typeof oldDiffToPGUMap
            ];
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

      const complexChars = ['[', '(', '{', '}', ']', ')'];
      const hasSimpleCredits = !complexChars.some(
        char =>
          level.creator.includes(char) ||
          level.charter.includes(char) ||
          level.vfxer.includes(char),
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
        isVerified: hasSimpleCredits,
      });
    }

    updateProgress(50, 'Pass Processing', 'Processing new passes');
    const passes = passesResponse.results;
    const newPasses = passes.filter(pass => !existingPassIds.has(pass.id));

    const players = await db.models.Player.findAll({
      attributes: ['id', 'name'],
      transaction,
    });
    const playerNameToId = new Map(players.map((p: any) => [p.name, p.id]));

    const feelingRatings = await readFeelingRatingsFromXlsx();

    const passDocs = [];
    const judgementDocs = [];
    let lastValidUploadTime = new Date('2000-01-01 00:00:00');

    const levelFirstPasses = new Map<number, {uploadTime: Date; id: number}>();

    // First, get existing passes for all affected levels
    const existingPassesForLevels = await db.models.Pass.findAll({
      where: {
        levelId: newPasses.map(p => p.levelId),
        isDeleted: false,
      },
      attributes: ['id', 'levelId', 'vidUploadTime'],
      transaction,
    });

    // Initialize levelFirstPasses with existing passes
    existingPassesForLevels.forEach((pass: PassDoc) => {
      const uploadTime = new Date(pass.vidUploadTime);
      const currentFirst = levelFirstPasses.get(pass.levelId);
      if (!currentFirst || uploadTime < currentFirst.uploadTime) {
        levelFirstPasses.set(pass.levelId, {uploadTime, id: pass.id});
      }
    });

    // Then check new passes
    for (const pass of newPasses) {
      const uploadTime = new Date(pass.vidUploadTime);
      const currentFirst = levelFirstPasses.get(pass.levelId);

      // Only consider this pass for world's first if:
      // 1. No existing world's first OR
      // 2. This pass is earlier than current world's first
      if (!currentFirst || uploadTime < currentFirst.uploadTime) {
        levelFirstPasses.set(pass.levelId, {uploadTime, id: pass.id});
      }
    }

    // Get clear counts for existing levels
    const existingLevelClearCounts = await db.models.Level.findAll({
      where: {
        id: newPasses.map(p => p.levelId),
      },
      attributes: ['id', 'clears'],
      transaction,
    });
    const clearCountMap = new Map(
      existingLevelClearCounts.map((l: any) => [l.id, l.clears]),
    );

    for (const pass of newPasses) {
      const playerId = playerNameToId.get(pass.player);
      if (!playerId) continue;

      if (pass.vidUploadTime) {
        const uploadTime = new Date(pass.vidUploadTime);
        if (uploadTime instanceof Date && !isNaN(uploadTime.getTime())) {
          lastValidUploadTime = uploadTime;
        }
      }

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

      const level =
        levelDocs.find((l: LevelDoc) => l.id === pass.levelId) ||
        (await db.models.Level.findByPk(pass.levelId, {
          include: [
            {
              model: db.models.Difficulty,
              as: 'difficulty',
            },
          ],
          transaction,
        }));
      const difficulty = level?.difficulty;
      const baseScore = level?.baseScore || difficulty?.baseScore || 0;

      const accuracy = calcAcc(judgements);
      const scoreV2 = getScoreV2(
        {
          speed: pass.speed || 1,
          isNoHoldTap: pass.isNoHoldTap || false,
          judgements: {
            earlyDouble: judgements.earlyDouble || 0,
            earlySingle: judgements.earlySingle || 0,
            ePerfect: judgements.ePerfect || 0,
            perfect: judgements.perfect || 0,
            lPerfect: judgements.lPerfect || 0,
            lateSingle: judgements.lateSingle || 0,
            lateDouble: judgements.lateDouble || 0,
          },
        },
        {
          baseScore: baseScore,
          difficulty: {
            baseScore: baseScore || 0,
          },
        },
      );

      const isWorldsFirst =
        levelFirstPasses.get(pass.levelId)?.id === pass.id ||
        clearCountMap.get(pass.levelId) === 0;

      passDocs.push({
        id: pass.id,
        levelId: pass.levelId,
        playerId: playerId,
        speed: pass.speed || 1,
        feelingRating:
          feelingRatings.get(pass.id)?.toString() || pass.feelingRating,
        vidTitle: pass.vidTitle,
        videoLink: pass.vidLink,
        vidUploadTime: pass.vidUploadTime
          ? new Date(pass.vidUploadTime)
          : lastValidUploadTime,
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

    updateProgress(70, 'Data Creation', 'Creating new data');
    if (levelDocs.length > 0) {
      await db.models.Level.bulkCreate(levelDocs as any, {transaction});
    }

    if (passDocs.length > 0) {
      await db.models.Pass.bulkCreate(passDocs as any, {transaction});
      await db.models.Judgement.bulkCreate(judgementDocs, {transaction});
    }

    if (levelDocs.length > 0) {
      await migrateNewCredits(levelDocs as any, transaction);
    }

    updateProgress(80, 'Finalizing', 'Updating clear counts');
    const affectedLevelIds = new Set([
      ...newLevels.map((l: RawLevel) => l.id),
      ...newPasses.map(p => p.levelId),
    ]);
    for (const levelId of affectedLevelIds) {
      const clearCount = await db.models.Pass.count({
        where: {
          levelId,
          isDeleted: false,
          '$player.isBanned$': false,
        },
        include: [
          {
            model: db.models.Player,
            as: 'player',
            required: true,
          },
        ],
        transaction,
      });

      await db.models.Level.update(
        {
          clears: clearCount,
          isCleared: clearCount > 0,
        },
        {
          where: {id: levelId},
          transaction,
        },
      );
    }
    updateProgress(90, 'Finalizing', 'Creating ratings');
    const unrankedLevels = await db.models.Level.findAll({
      where: {
        id: levelDocs.filter(l => l.diffId === 0).map(l => l.id),
        isDeleted: false,
        isHidden: false,
      },
      transaction,
    });

    if (unrankedLevels.length > 0) {
      const ratingDocs = unrankedLevels.map((level: any) => ({
        levelId: level.id,
        currentDifficultyId: 0,
        lowDiff: /^[pP]\d/.test(level.rerateNum || ''),
        requesterFR: level.rerateNum || '',
        averageDifficultyId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      await db.models.Rating.bulkCreate(ratingDocs, {transaction});
      await db.models.Level.update(
        {toRate: true},
        {
          where: {id: unrankedLevels.map((l: any) => l.id)},
          transaction,
        },
      );
    }

    updateProgress(100, 'Complete', 'Committing transaction');
    await transaction.commit();
    mainBar.stop();
    return true;
  } catch (error) {
    mainBar.stop();
    await transaction.rollback();
    throw error;
  }
}

export default reloadDatabase;
