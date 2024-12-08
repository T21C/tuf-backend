import axios from 'axios';
import db from '../models/index';
import { Cache } from './cacheManager';
import { IPlayer, ILevel } from '../types/models';
import { updateAllPlayerPfps } from './PlayerEnricher';
import xlsx from 'xlsx';

const BE_API = 'http://be.t21c.kro.kr';

interface RawLevel {
  id: number;
  song: string;
  artist: string;
  creator: string;
  charter: string;
  vfxer: string;
  team: string;
  diff: number;
  legacyDiff: number;
  pguDiff: string;
  pguDiffNum: number;
  newDiff: number;
  pdnDiff: number;
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
      const rating = row['Feeling Difficulty']?.toString() || "";
      if (id != 0 && !isNaN(id) && rating != "") {
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

async function reloadDatabase() {
  const transaction = await db.sequelize.transaction();

  try {
    console.log('Starting database reload...');

    // Clear existing data
    await Promise.all([
      db.models.Level.destroy({ where: {}, transaction }),
      db.models.Pass.destroy({ where: {}, transaction }),
      db.models.Player.destroy({ where: {}, transaction }),
      db.models.Rating.destroy({ where: {}, transaction }),
      db.models.Judgement.destroy({ where: {}, transaction })
    ]);
    console.log('Cleared existing data');

    // Load data from BE API
    const [playersResponse, levelsResponse, passesResponse] = await Promise.all([
      fetchData<RawPlayer[]>('/players'),
      fetchData<RawLevel[]>('/levels'),
      fetchData<{ count: number, results: RawPass[] }>('/passes')
    ]);

    // Process players
    const players = Array.isArray(playersResponse) ? playersResponse : 
                   (playersResponse as any).results || [];
    const playerDocs = players
      .filter((player: RawPlayer) => player.name)
      .map((player: RawPlayer, index: number) => ({
        id: index + 1,
        name: player.name,
        country: player.country || 'XX',
        isBanned: player.isBanned || false
      }));

    // Process levels
    const levels = Array.isArray(levelsResponse) ? levelsResponse : 
                  (levelsResponse as any).results || [];
    
    // Sort levels by ID to process them in order
    levels.sort((a: any, b: any) => a.id - b.id);
    
    const levelDocs: any[] = [];
    const levelIdMapping = new Map<number, number>();
    let nextDbId = 1;

    // Create a placeholder level for gaps
    const createPlaceholderLevel = (dbId: number) => ({
      id: dbId,
      song: 'Placeholder',
      artist: 'Unknown',
      creator: 'Unknown',
      charter: 'Unknown',
      vfxer: 'Unknown',
      team: 'Unknown',
      diff: 0,
      legacyDiff: 0,
      pguDiff: 'U',
      pguDiffNum: 0,
      newDiff: 0,
      baseScore: 0,
      baseScoreDiff: 0,
      isCleared: false,
      clears: 0,
      vidLink: '',
      dlLink: '',
      workshopLink: '',
      publicComments: 'Placeholder for missing level',
      toRate: false,
      isDeleted: true
    });

    // Process each level and fill gaps
    for (const level of levels) {
      // Fill any gaps before this level
      while (nextDbId < level.id) {
        console.log(`Creating placeholder for missing level ID ${nextDbId}`);
        const placeholder = createPlaceholderLevel(nextDbId);
        levelDocs.push(placeholder);
        levelIdMapping.set(nextDbId, nextDbId);
        nextDbId++;
      }

      // Add the actual level
      const dbId = nextDbId;
      levelDocs.push({
        ...level,
        id: dbId,
        baseScoreDiff: level.baseScore || 0,
        toRate: false
      });
      levelIdMapping.set(level.id, dbId);
      nextDbId++;
    }

    console.log(`Processed ${levelDocs.length} levels (including ${levelDocs.length - levels.length} placeholders)`);

    // Create ID mappings
    const playerNameToId = new Map<string, number>(
      playerDocs.map((p: any) => [p.name, p.id])
    );

    // Load feeling ratings
    const feelingRatings = await readFeelingRatingsFromXlsx();

    // Process passes and judgements
    const passes = passesResponse.results;
    const passDocs = [];
    const judgementDocs = [];

    // First, organize passes by level to determine world's firsts
    const levelFirstPasses = new Map<number, { uploadTime: Date, passId: number }>();
    passes.forEach((pass: RawPass) => {
      const newLevelId = levelIdMapping.get(pass.levelId);
      if (typeof newLevelId !== 'number') return;

      const uploadTime = new Date(pass.vidUploadTime);
      const currentFirst = levelFirstPasses.get(newLevelId);
      
      if (!currentFirst || uploadTime < currentFirst.uploadTime) {
        levelFirstPasses.set(newLevelId, { uploadTime, passId: pass.id });
      }
    });

    for (const pass of passes) {
      const playerId = playerNameToId.get(pass.player);
      const newLevelId = levelIdMapping.get(pass.levelId);
      
      if (playerId && typeof newLevelId === 'number') {
        // Check if this pass is the world's first for its level
        const isWorldsFirst = levelFirstPasses.get(newLevelId)?.passId === pass.id;

        passDocs.push({
          id: pass.id,
          levelId: newLevelId,
          playerId: playerId,
          feelingRating: feelingRatings.get(pass.id)?.toString() || pass.feelingRating,
          vidTitle: pass.vidTitle,
          vidLink: pass.vidLink,
          vidUploadTime: new Date(pass.vidUploadTime),
          is12K: pass.is12K,
          is16K: false,
          isNoHoldTap: pass.isNoHoldTap,
          isLegacyPass: pass.isLegacyPass,
          isWorldsFirst,
          accuracy: pass.accuracy,
          scoreV2: pass.scoreV2,
          isDeleted: false
        });

        judgementDocs.push({
          passId: pass.id,
          earlyDouble: Number(pass.judgements[0]) || 0,
          earlySingle: Number(pass.judgements[1]) || 0,
          ePerfect: Number(pass.judgements[2]) || 0,
          perfect: Number(pass.judgements[3]) || 0,
          lPerfect: Number(pass.judgements[4]) || 0,
          lateSingle: Number(pass.judgements[5]) || 0,
          lateDouble: Number(pass.judgements[6]) || 0
        });
      }
    }

    // Bulk insert all data
    await Promise.all([
      db.models.Player.bulkCreate(playerDocs, { transaction }),
      db.models.Level.bulkCreate(levelDocs, { transaction }),
      db.models.Pass.bulkCreate(passDocs, { transaction }),
      db.models.Judgement.bulkCreate(judgementDocs, { transaction })
    ]);

    // Update clear counts
    const clearCounts = new Map<number, number>();
    const nonBannedPlayerIds = new Set(playerDocs.filter((p: any) => !p.isBanned).map((p: any) => p.id));

    passDocs.forEach((pass: any) => {
      if (nonBannedPlayerIds.has(pass.playerId)) {
        clearCounts.set(pass.levelId, (clearCounts.get(pass.levelId) || 0) + 1);
      }
    });

    await Promise.all(
      Array.from(clearCounts.entries()).map(([levelId, clears]) =>
        db.models.Level.update(
          { clears }, 
          { where: { id: levelId }, transaction }
        )
      )
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
