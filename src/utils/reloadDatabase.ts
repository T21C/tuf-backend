import axios from 'axios';
import Level from '../models/Level';
import Pass from '../models/Pass';
import Player, { IPlayer } from '../models/Player';
import { Rating } from '../models/Rating';
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
}

interface RawPlayer {
  name: string;
  country: string;
  isBanned: boolean;
}

async function fetchData<T>(endpoint: string): Promise<T> {
  const response = await axios.get(`${BE_API}${endpoint}`);
  //console.log(`Response from ${endpoint}:`, typeof response.data, response.data);
  return response.data;
}

async function readFeelingRatingsFromXlsx(): Promise<Map<number, string>> {
  try {
    const workbook = xlsx.readFile('./cache/passes.xlsx');
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rawData = xlsx.utils.sheet_to_json(worksheet);
    
    // Create a Map of id -> feelingRating
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
  try {
    console.log('Starting database reload...');

    // Clear existing collections
    await Promise.all([
      Level.deleteMany({}),
      Pass.deleteMany({}),
      Player.deleteMany({}),
      Rating.deleteMany({})
    ]);
    console.log('Cleared existing collections');

    // Load feeling ratings from XLSX first
    const feelingRatings = await readFeelingRatingsFromXlsx();

    // Fetch and process levels
    const levelsResponse = await fetchData<RawLevel[]>('/levels');
    const levels = Array.isArray(levelsResponse) ? levelsResponse : 
                  (levelsResponse as any).results || [];

    // Process and insert levels
    const levelDocs = Array.isArray(levels) ? levels.map(level => ({
      ...level,
      baseScoreDiff: level.baseScore || 0,
      toRate: false
    })) : [];
    
    if (levelDocs.length === 0) {
      console.warn('No levels to insert');
    } else {
      await Level.insertMany(levelDocs);
      console.log(`Inserted ${levelDocs.length} levels`);
    }

    // Fetch and process players first
    const playersResponse = await fetchData<RawPlayer[]>('/players');
    const players = Array.isArray(playersResponse) ? playersResponse : 
                   (playersResponse as any).results || [];

    // Create a map to store player name to ID mappings
    const playerNameToId = new Map<string, number>();
    
    // Process and validate player data, assigning incremental IDs
    const playerDocs = players
      .filter((player: RawPlayer) => player.name)
      .map((player: RawPlayer, index: number) => {
        const playerId = index + 1; // Generate sequential IDs starting from 1
        playerNameToId.set(player.name, playerId);
        return {
          id: playerId,
          name: player.name,
          country: player.country || 'XX',
          isBanned: player.isBanned || false
        };
      });

    if (playerDocs.length === 0) {
      console.warn('No players to insert');
    } else {
      await Player.insertMany(playerDocs);
      console.log(`Inserted ${playerDocs.length} players with generated IDs`);
    }

    // Log playerNameToId map for debugging
    console.log('Player Name to ID Map:', playerNameToId);

    // Fetch and process passes
    const passesResponse = await fetchData<{ count: number, results: RawPass[] }>('/passes');
    const passes = passesResponse.results;

    // Enrich passes with feeling ratings and convert player names to IDs
    const enrichedPasses = passes.map(pass => {
      const playerId = playerNameToId.get(pass.player);
      if (playerId === undefined) {
        console.warn(`No ID found for player: ${pass.player}`);
      }
      return {
        ...pass,
        feelingRating: feelingRatings.get(pass.id)?.toString() || pass.feelingRating,
        playerId  // Add playerId while keeping the original player name
      };
    }).filter(pass => pass.playerId !== undefined); // Filter out passes with invalid player IDs

    // Log enrichedPasses for debugging
    console.log('Enriched Passes:', enrichedPasses);

    // Process and insert passes
    const passDocs = enrichedPasses.map(pass => ({
      id: pass.id,
      levelId: pass.levelId,
      speed: pass.speed,
      player: pass.player,    // Keep the player name
      playerId: pass.playerId, // And include the playerId
      feelingRating: pass.feelingRating,
      vidTitle: pass.vidTitle,
      vidLink: pass.vidLink,
      vidUploadTime: new Date(pass.vidUploadTime),
      is12K: pass.is12K,
      is16K: false,
      isNoHoldTap: pass.isNoHoldTap,
      isLegacyPass: pass.isLegacyPass,
      accuracy: pass.accuracy,
      scoreV2: pass.scoreV2,
      judgements: {
        earlyDouble: pass.judgements[0],
        earlySingle: pass.judgements[1],
        ePerfect: pass.judgements[2],
        perfect: pass.judgements[3],
        lPerfect: pass.judgements[4],
        lateSingle: pass.judgements[5],
        lateDouble: pass.judgements[6]
      }
    }));

    if (passDocs.length === 0) {
      console.warn('No passes to insert');
    } else {
      await Pass.insertMany(passDocs, { ordered: false });
      console.log(`Inserted ${passDocs.length} passes with player IDs`);
    }

    // Recount clear counts for each level
    const nonBannedPlayerIds = new Set(
      playerDocs
        .filter((player: IPlayer) => !player.isBanned)
        .map((player: IPlayer) => player.id)
    );

    const clearCounts = new Map<number, number>();

    passDocs.forEach(pass => {
      if (nonBannedPlayerIds.has(pass.playerId)) {
        clearCounts.set(pass.levelId, (clearCounts.get(pass.levelId) || 0) + 1);
      }
    });

    // Update levels with new clear counts
    for (const [levelId, clears] of clearCounts.entries()) {
      await Level.updateOne({ id: levelId }, { $set: { clears } });
    }

    console.log('Recounted clear counts for all levels');
    console.log('Database reload completed successfully');
  } catch (error) {
    console.error('Error reloading database:', error);
    console.error('Error details:', {
      name: (error as any).name,
      message: (error as any).message,
      stack: (error as any).stack
    });
    throw error;
  }
}

// Export for use in other files
export default reloadDatabase;
