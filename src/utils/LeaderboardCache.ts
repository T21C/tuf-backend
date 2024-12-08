import { IPlayer } from '../types/models';
import Player from '../models/Player';
import Pass from '../models/Pass';
import Level from '../models/Level';
import Judgement from '../models/Judgement';
import { enrichPlayerData } from './PlayerEnricher';

interface PlayerRankings {
  rankedScore: number;
  generalScore: number;
  ppScore: number;
  wfScore: number;
  score12k: number;
}

interface CachedPlayer extends IPlayer {
  rankings: PlayerRankings;
}

class LeaderboardCache {
  private static instance: LeaderboardCache;
  private playerCache: Map<number, CachedPlayer> = new Map();
  private sortedRankings: Map<string, number[]> = new Map();
  private isInitialized = false;

  private constructor() {}

  static getInstance(): LeaderboardCache {
    if (!LeaderboardCache.instance) {
      LeaderboardCache.instance = new LeaderboardCache();
    }
    return LeaderboardCache.instance;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    
    console.log('Initializing leaderboard cache...');
    await this.updateCache();
    this.isInitialized = true;
    console.log('Leaderboard cache initialized');
  }

  private async updateCache(): Promise<void> {
    try {
      // Fetch all players with their data
      const players = await Player.findAll({
        include: [{
          model: Pass,
          as: 'playerPasses',
          include: [{
            model: Level,
            as: 'level',
            attributes: ['id', 'song', 'artist', 'pguDiff', 'baseScore']
          },
          {
            model: Judgement,
            as: 'judgements',
            attributes: ['earlyDouble', 'earlySingle', 'ePerfect', 'perfect', 'lPerfect', 'lateSingle', 'lateDouble']
          }]
        }]
      });

      // Clear existing cache
      this.playerCache.clear();
      this.sortedRankings.clear();

      // Enrich players and store in cache
      const enrichedPlayers = await Promise.all(
        players.map(player => enrichPlayerData(player))
      );

      // Store players in cache
      for (const player of enrichedPlayers) {
        const rankings: PlayerRankings = {
          rankedScore: player.rankedScore ?? 0,
          generalScore: player.generalScore ?? 0,
          ppScore: player.ppScore ?? 0,
          wfScore: player.wfScore ?? 0,
          score12k: player.score12k ?? 0
        };

        this.playerCache.set(player.id, {
          ...player,
          rankings
        });
      }

      // Update sorted rankings for each score type
      const scoreTypes = ['rankedScore', 'generalScore', 'ppScore', 'wfScore', 'score12k'];
      for (const scoreType of scoreTypes) {
        const sorted = Array.from(this.playerCache.values())
          .sort((a, b) => (b.rankings[scoreType as keyof PlayerRankings] ?? 0) - (a.rankings[scoreType as keyof PlayerRankings] ?? 0))
          .map(p => p.id);
        this.sortedRankings.set(scoreType, sorted);
      }

      console.log(`Cache updated with ${this.playerCache.size} players`);
    } catch (error) {
      console.error('Error updating leaderboard cache:', error);
      throw error;
    }
  }

  async refreshCache(): Promise<void> {
    console.log('Refreshing leaderboard cache...');
    await this.updateCache();
    console.log('Leaderboard cache refreshed');
  }

  getPlayer(id: number): CachedPlayer | undefined {
    return this.playerCache.get(id);
  }

  getRank(playerId: number, scoreType: string = 'rankedScore'): number {
    const rankings = this.sortedRankings.get(scoreType);
    if (!rankings) return -1;
    
    const index = rankings.indexOf(playerId);
    return index === -1 ? -1 : index + 1;
  }

  getAllRanks(playerId: number): PlayerRankings {
    const rankings: Partial<PlayerRankings> = {};
    const scoreTypes = ['rankedScore', 'generalScore', 'ppScore', 'wfScore', 'score12k'];
    
    for (const scoreType of scoreTypes) {
      rankings[scoreType as keyof PlayerRankings] = this.getRank(playerId, scoreType);
    }
    
    return rankings as PlayerRankings;
  }

  getLeaderboard(scoreType: string = 'rankedScore', limit?: number): CachedPlayer[] {
    const rankings = this.sortedRankings.get(scoreType);
    if (!rankings) return [];
    
    const playerIds = limit ? rankings.slice(0, limit) : rankings;
    return playerIds
      .map(id => this.playerCache.get(id))
      .filter((player): player is CachedPlayer => player !== undefined);
  }
}

export default LeaderboardCache; 