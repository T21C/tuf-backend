import axios from 'axios';
import Level from '../models/Level';
import Pass from '../models/Pass';
import Player from '../models/Player';
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
  console.log(`Response from ${endpoint}:`, typeof response.data, response.data);
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
        console.log(`Rating for ${id}: ${rating}`);
        console.log(typeof rating);
        if (rating.toLowerCase() == "u14") {
          console.log(`Setting rating for ${id} to u14`);
        }
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
      Player.deleteMany({})
    ]);
    console.log('Cleared existing collections');

    // Load feeling ratings from XLSX first
    const feelingRatings = await readFeelingRatingsFromXlsx();

    // Fetch and process levels
    const levelsResponse = await fetchData<RawLevel[]>('/levels');
    const levels = Array.isArray(levelsResponse) ? levelsResponse : 
                  (levelsResponse as any).results || [];
    
    console.log('Levels data structure:', {
      isArray: Array.isArray(levels),
      length: levels.length,
      firstItem: levels[0]
    });

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

    // Fetch and process passes
    const passesResponse = await fetchData<{ count: number, results: RawPass[] }>('/passes');
    const passes = passesResponse.results;
    
    console.log('Passes data structure:', {
      count: passes.length,
      firstItem: passes[0]
    });

    // Enrich passes with feeling ratings
    const enrichedPasses = passes.map(pass => ({
      ...pass,
      feelingRating: feelingRatings.get(pass.id)?.toString() || pass.feelingRating
    }));

    // Process and insert passes
    const passDocs = enrichedPasses.map(pass => ({
      id: pass.id,
      levelId: pass.levelId,
      speed: pass.speed,
      player: pass.player,
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
      console.log('Sample enriched pass:', {
        id: passDocs[0].id,
        originalRating: passes[0].feelingRating,
        enrichedRating: passDocs[0].feelingRating
      });
      
      try {
        await Pass.insertMany(passDocs, { ordered: false });
        console.log(`Inserted ${passDocs.length} passes`);
      } catch (error) {
        console.error('Error inserting passes:', error);
        if ((error as any).writeErrors) {
          console.error('First write error:', (error as any).writeErrors[0]);
        }
        throw error;
      }
    }

    // Fetch and validate players
    const playersResponse = await fetchData<RawPlayer[]>('/players');
    const players = Array.isArray(playersResponse) ? playersResponse : 
                   (playersResponse as any).results || [];
    
    console.log('Players data structure:', {
      isArray: Array.isArray(players),
      length: players.length,
      firstItem: players[0]
    });

    // Process and validate player data
    const playerDocs = players.map((player: any) => ({
      name: player.name || '',
      country: player.country || 'XX', // Default country code if missing
      isBanned: player.isBanned || false
    })).filter((player: any) => player.name); // Filter out players without names

    if (playerDocs.length === 0) {
      console.warn('No players to insert');
    } else {
      // Log sample player for debugging
      console.log('Sample player document:', playerDocs[0]);
      
      try {
        await Player.insertMany(playerDocs, { 
          ordered: false,
        });
        console.log(`Inserted ${playerDocs.length} players`);
      } catch (error) {
        console.error('Error inserting players:', error);
        if ((error as any).writeErrors) {
          console.error('First write error:', (error as any).writeErrors[0]);
        }
        throw error;
      }
    }

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
