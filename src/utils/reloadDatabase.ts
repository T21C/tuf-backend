import axios from 'axios';
import mongoose from 'mongoose';
import Level from '../models/Level';
import Pass from '../models/Pass';
import Player from '../models/Player';

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

    // Fetch and validate levels
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
      toRate: false
    })) : [];
    
    if (levelDocs.length === 0) {
      console.warn('No levels to insert');
    } else {
      await Level.insertMany(levelDocs);
      console.log(`Inserted ${levelDocs.length} levels`);
    }

    // Fetch and validate passes
    const passesResponse = await fetchData<{ count: number, results: RawPass[] }>('/passes');
    const passes = passesResponse.results || [];
    
    console.log('Passes data structure:', {
      count: passesResponse.count,
      resultsLength: passes.length,
      firstItem: passes[0]
    });

    // Process and insert passes
    const passDocs = passes.map(pass => {
      // Ensure all judgement values exist with fallbacks to 0
      const judgementArray = pass.judgements || [0, 0, 0, 0, 0, 0, 0];
      
      return {
        id: pass.id,
        levelId: pass.levelId,
        speed: pass.speed,
        player: pass.player,
        feelingRating: pass.feelingRating || '',
        vidTitle: pass.vidTitle,
        vidLink: pass.vidLink,
        vidUploadTime: new Date(pass.vidUploadTime),
        is12K: pass.is12K || false,
        is16K: false,
        isNoHoldTap: pass.isNoHoldTap || false,
        isLegacyPass: pass.isLegacyPass || false,
        accuracy: pass.accuracy,
        scoreV2: pass.scoreV2,
        judgements: {
          earlyDouble: judgementArray[0] || 0,
          earlySingle: judgementArray[1] || 0,
          ePerfect: judgementArray[2] || 0,
          perfect: judgementArray[3] || 0,
          lPerfect: judgementArray[4] || 0,
          lateSingle: judgementArray[5] || 0,
          lateDouble: judgementArray[6] || 0
        }
      };
    });

    if (passDocs.length === 0) {
      console.warn('No passes to insert');
    } else {
      // Log the first pass doc for debugging
      console.log('Sample pass document:', passDocs[0]);
      
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
