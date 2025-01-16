import {Request, Response, NextFunction} from 'express';
import Player from '../models/Player';
import Pass from '../models/Pass';
import Level from '../models/Level';
import Judgement from '../models/Judgement';
import {enrichPlayerData} from '../utils/PlayerEnricher';
import {IPlayer} from '../interfaces/models';
import Difficulty from '../models/Difficulty';
import cliProgress from 'cli-progress';
import colors from 'ansi-colors';

// Constants for cache management
const CACHE_BATCH_SIZE = 50;
const CACHE_UPDATE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const CACHE_BATCH_TIMEOUT = 30 * 1000; // 30 seconds per batch

// Progress bar for cache updates
const progressBar = new cliProgress.SingleBar({
  format: colors.cyan('{bar}') + ' | {percentage}% | Cache Update | {status}',
  barCompleteChar: '\u2588',
  barIncompleteChar: '\u2591',
  hideCursor: true,
}, cliProgress.Presets.shades_classic);

// Define the middleware function type with initialize property
type CacheMiddleware = ((
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<void | Response>) & {
  initialize: () => Promise<void>;
};

interface PlayerRanks {
  rankedScoreRank: number;
  generalScoreRank: number;
  ppScoreRank: number;
  wfScoreRank: number;
  score12kRank: number;
}

export class LeaderboardCache {
  private cache: Map<string, any[]>;
  private lastUpdate: Date;
  private updateInterval: number;
  private isUpdating: boolean;
  private updateTimeout: NodeJS.Timeout | null;
  private static instance: LeaderboardCache;
  private abortController: AbortController | null;

  private constructor() {
    this.cache = new Map();
    this.lastUpdate = new Date(0);
    this.updateInterval = 5 * 60 * 1000; // 5 minutes
    this.isUpdating = false;
    this.updateTimeout = null;
    this.abortController = null;

    // Handle process termination
    process.on('SIGINT', () => this.handleShutdown());
    process.on('SIGTERM', () => this.handleShutdown());
  }

  private async handleShutdown() {
    if (this.isUpdating) {
      console.log('\nGracefully stopping cache update...');
      this.abortController?.abort();
      if (this.updateTimeout) {
        clearTimeout(this.updateTimeout);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    process.exit(0);
  }

  private async loadPlayersInBatches(signal: AbortSignal): Promise<Player[]> {
    const allPlayers: Player[] = [];
    let offset = 0;
    
    while (!signal.aborted) {
      try {
        const batchPlayers = await Player.findAll({
          include: [{
            model: Pass,
            as: 'passes',
            attributes: [
              'id', 'levelId', 'speed', 'playerId',
              'is12K', 'isWorldsFirst', 'accuracy', 'scoreV2', 'isDeleted'
            ],
            include: [{
              model: Level,
              as: 'level',
              attributes: ['id', 'baseScore', 'diffId'],
              include: [{
                model: Difficulty,
                as: 'difficulty',
                attributes: ['name', 'sortOrder']
              }]
            }]
          }],
          limit: CACHE_BATCH_SIZE,
          offset: offset,
          order: [['id', 'ASC']]
        });

        if (batchPlayers.length === 0) break;
        allPlayers.push(...batchPlayers);
        offset += CACHE_BATCH_SIZE;

        // Update progress
        const progress = Math.min(100, (offset / (offset + CACHE_BATCH_SIZE)) * 100);
        progressBar.update(progress, { status: `Loading players (${allPlayers.length} loaded)` });

      } catch (error) {
        if (signal.aborted) break;
        console.error('Error loading player batch:', error);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return allPlayers;
  }

  private async processPlayerBatch(
    players: Player[],
    start: number,
    total: number,
    signal: AbortSignal
  ): Promise<IPlayer[]> {
    if (signal.aborted) {
      return [];
    }

    try {
      // Process the entire batch in parallel
      const enrichedPlayers = await Promise.all(
        players.map(async (player, index) => {
          try {
            const enriched = await enrichPlayerData(player);
            const progress = Math.min(100, ((start + index + 1) / total) * 100);
            progressBar.update(progress, { 
              status: `Processing players (${start + index + 1}/${total})` 
            });
            return enriched;
          } catch (error) {
            console.error(`Error processing player ${player.id}:`, error);
            return null;
          }
        })
      );

      // Filter out failed entries
      return enrichedPlayers.filter((player): player is IPlayer => player !== null);
    } catch (error) {
      console.error('Batch processing error:', error);
      return [];
    }
  }

  private async updateCache() {
    if (this.isUpdating) {
      return;
    }

    this.isUpdating = true;
    this.abortController = new AbortController();
    progressBar.start(100, 0, { status: 'Starting cache update' });

    try {
      // Set overall timeout
      this.updateTimeout = setTimeout(() => {
        console.log('\nCache update timeout reached, aborting...');
        this.abortController?.abort();
      }, CACHE_UPDATE_TIMEOUT);

      // Load all players in batches
      const players = await this.loadPlayersInBatches(this.abortController.signal);
      
      if (this.abortController.signal.aborted) {
        throw new Error('Cache update aborted');
      }

      // Process players in batches
      const enrichedPlayers: IPlayer[] = [];
      for (let i = 0; i < players.length; i += CACHE_BATCH_SIZE) {
        const batch = players.slice(i, Math.min(i + CACHE_BATCH_SIZE, players.length));
        const batchResults = await this.processPlayerBatch(
          batch,
          i,
          players.length,
          this.abortController.signal
        );
        enrichedPlayers.push(...batchResults);

        if (this.abortController.signal.aborted) {
          throw new Error('Cache update aborted');
        }
      }

      // Update cache with processed players
      const sortOptions = ['rankedScore', 'generalScore', 'ppScore', 'wfScore', 'score12k'];
      const orders = ['asc', 'desc'];
      const includeScoresOptions = [true, false];

      progressBar.update(95, { status: 'Updating cache entries' });

      for (const sortBy of sortOptions) {
        for (const order of orders) {
          for (const includeScores of includeScoresOptions) {
            if (this.abortController.signal.aborted) break;

            const sortedPlayers = [...enrichedPlayers].sort((a, b) => {
              const valueA = a[sortBy as keyof IPlayer] ?? 0;
              const valueB = b[sortBy as keyof IPlayer] ?? 0;
              return order === 'asc'
                ? (valueA as number) - (valueB as number)
                : (valueB as number) - (valueA as number);
            });

            const finalPlayers = includeScores
              ? sortedPlayers
              : sortedPlayers.map(({passes, ...player}) => player);

            const key = this.getCacheKey(sortBy, order, includeScores);
            this.cache.set(key, finalPlayers);
          }
        }
      }

      this.lastUpdate = new Date();
      progressBar.update(100, { status: 'Cache update complete' });
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'Cache update aborted') {
        console.log('\nCache update was aborted');
      } else {
        console.error('\nError updating leaderboard cache:', error);
        throw error;
      }
    } finally {
      if (this.updateTimeout) {
        clearTimeout(this.updateTimeout);
        this.updateTimeout = null;
      }
      this.abortController = null;
      this.isUpdating = false;
      progressBar.stop();
    }
  }

  public static getInstance(): LeaderboardCache {
    if (!LeaderboardCache.instance) {
      LeaderboardCache.instance = new LeaderboardCache();
    }
    return LeaderboardCache.instance;
  }

  public async get(
    sortBy = 'rankedScore',
    order = 'desc',
    includeAllScores = false,
  ): Promise<any[]> {
    if (this.needsUpdate()) {
      await this.updateCache();
    }

    const key = this.getCacheKey(sortBy, order, includeAllScores);
    return this.cache.get(key) || [];
  }

  public async getRanks(playerId: number): Promise<PlayerRanks> {
    if (this.needsUpdate()) {
      await this.updateCache();
    }

    const ranks: PlayerRanks = {
      rankedScoreRank: 0,
      generalScoreRank: 0,
      ppScoreRank: 0,
      wfScoreRank: 0,
      score12kRank: 0,
    };

    const rankedScoreLeaderboard = await this.get('rankedScore', 'desc', false);
    const generalScoreLeaderboard = await this.get(
      'generalScore',
      'desc',
      false,
    );
    const ppScoreLeaderboard = await this.get('ppScore', 'desc', false);
    const wfScoreLeaderboard = await this.get('wfScore', 'desc', false);
    const score12kLeaderboard = await this.get('score12k', 'desc', false);

    ranks.rankedScoreRank =
      rankedScoreLeaderboard.findIndex(p => p.id === playerId) + 1;
    ranks.generalScoreRank =
      generalScoreLeaderboard.findIndex(p => p.id === playerId) + 1;
    ranks.ppScoreRank =
      ppScoreLeaderboard.findIndex(p => p.id === playerId) + 1;
    ranks.wfScoreRank =
      wfScoreLeaderboard.findIndex(p => p.id === playerId) + 1;
    ranks.score12kRank =
      score12kLeaderboard.findIndex(p => p.id === playerId) + 1;

    const totalPlayers = rankedScoreLeaderboard.length;
    ranks.rankedScoreRank = ranks.rankedScoreRank || totalPlayers + 1;
    ranks.generalScoreRank = ranks.generalScoreRank || totalPlayers + 1;
    ranks.ppScoreRank = ranks.ppScoreRank || totalPlayers + 1;
    ranks.wfScoreRank = ranks.wfScoreRank || totalPlayers + 1;
    ranks.score12kRank = ranks.score12kRank || totalPlayers + 1;

    return ranks;
  }

  public async initialize() {
    await this.updateCache();
  }

  public async forceUpdate() {
    await this.updateCache();
  }

  private needsUpdate(): boolean {
    return Date.now() - this.lastUpdate.getTime() > this.updateInterval;
  }

  private getCacheKey(
    sortBy: string,
    order: string,
    includeAllScores: boolean,
  ): string {
    return `${sortBy}-${order}-${includeAllScores}`;
  }
}

// Export the Cache middleware factory with proper typing
export const Cache = {
  leaderboard: (): CacheMiddleware => {
    const middleware: CacheMiddleware = Object.assign(
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          req.leaderboardCache = LeaderboardCache.getInstance();
          return next();
        } catch (error) {
          console.error('Cache middleware error:', error);
          return res.status(500).json({error: 'Internal Server Error'});
        }
      },
      {
        initialize: async () => {
          return LeaderboardCache.getInstance().initialize();
        },
      },
    );

    return middleware;
  },
};
