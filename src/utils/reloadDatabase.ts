import axios from 'axios';
import db from '../models/index';
import { Op } from 'sequelize';
import xlsx from 'xlsx';
import { Cache } from './cacheManager';
import { IPlayer, ILevel } from '../types/models';

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
}

interface RawPlayer {
  name: string;
  country: string;
  isBanned: boolean;
}

async function fetchData<T>(endpoint: string): Promise<T> {
  const response = await axios.get(`${BE_API}${endpoint}`);
  return response.data;
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
    throw error;
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

    // Load feeling ratings
    const feelingRatings = await readFeelingRatingsFromXlsx();

    // Fetch and process players
    const playersResponse = await fetchData<RawPlayer[]>('/players');
    const players = Array.isArray(playersResponse) ? playersResponse : 
                   (playersResponse as any).results || [];

    // Create player name to ID mapping
    const playerNameToId = new Map<string, number>();
    
    // Process and insert players using db.models
    const playerDocs = players
      .filter((player: RawPlayer) => player.name)
      .map((player: RawPlayer, index: number) => ({
        id: index + 1,
        name: player.name,
        country: player.country || 'XX',
        isBanned: player.isBanned || false
      }));

    await db.models.Player.bulkCreate(playerDocs, { transaction });
    playerDocs.forEach((player: IPlayer) => playerNameToId.set(player.name, player.id));
    console.log(`Inserted ${playerDocs.length} players`);

    // Fetch and process levels
    const levelsResponse = await fetchData<RawLevel[]>('/levels');
    const levels = Array.isArray(levelsResponse) ? levelsResponse : 
                  (levelsResponse as any).results || [];

    // Create level ID mapping
    const levelIdMapping = new Map<number, number>();
    
    // Process levels and maintain a mapping of old to new IDs
    const levelDocs = levels.map((level: RawLevel, index: number) => {
      const newId = index + 1;
      levelIdMapping.set(level.id, newId);
      return {
        ...level,
        id: newId,  // Override the id with sequential numbers
        baseScoreDiff: level.baseScore || 0,
        toRate: false
      };
    });

    await db.models.Level.bulkCreate(levelDocs, { transaction });
    console.log(`Inserted ${levelDocs.length} levels`);

    // Process passes and judgements
    const passesResponse = await fetchData<{ count: number, results: RawPass[] }>('/passes');
    const passes = passesResponse.results;

    const passDocs = [];
    const judgementDocs = [];

    for (const pass of passes) {
      const playerId = playerNameToId.get(pass.player);
      const newLevelId = levelIdMapping.get(pass.levelId);
      
      if (playerId && newLevelId) {  // Only create pass if we have valid IDs
        passDocs.push({
          id: pass.id,
          levelId: newLevelId,  // Use the mapped level ID
          playerId: playerId,
          feelingRating: feelingRatings.get(pass.id)?.toString() || pass.feelingRating,
          vidTitle: pass.vidTitle,
          vidLink: pass.vidLink,
          vidUploadTime: new Date(pass.vidUploadTime),
          is12K: pass.is12K,
          is16K: false,
          isNoHoldTap: pass.isNoHoldTap,
          isLegacyPass: pass.isLegacyPass,
          accuracy: pass.accuracy,
          scoreV2: pass.scoreV2
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

    await db.models.Pass.bulkCreate(passDocs, { transaction });
    await db.models.Judgement.bulkCreate(judgementDocs, { transaction });
    console.log(`Inserted ${passDocs.length} passes with judgements`);

    // Update clear counts using new level IDs
    const clearCounts = new Map<number, number>();
    const nonBannedPlayerIds = new Set(
      playerDocs
        .filter((p: IPlayer) => !p.isBanned)
        .map((p: IPlayer) => p.id)
    );

    passDocs.forEach(pass => {
      if (nonBannedPlayerIds.has(pass.playerId)) {
        clearCounts.set(pass.levelId, (clearCounts.get(pass.levelId) || 0) + 1);
      }
    });

    // Update level clear counts
    await Promise.all(
      Array.from(clearCounts.entries()).map(([levelId, clears]) =>
        db.models.Level.update(
          { clears }, 
          { where: { id: levelId }, transaction }
        )
      )
    );

    await transaction.commit();
    console.log('Database reload completed successfully');

    // Reload cache after successful database update
    await Cache.reloadAll();
    console.log('Cache reloaded');

  } catch (error) {
    await transaction.rollback();
    console.error('Error reloading database:', error);
    throw error;
  }
}

export default reloadDatabase;
