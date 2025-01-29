import {Request, Response, NextFunction} from 'express';
import Player from '../models/Player.js';
import Pass from '../models/Pass.js';
import Level from '../models/Level.js';
import {enrichPlayerData} from '../utils/PlayerEnricher.js';
import {IPlayer} from '../interfaces/models/index.js';
import Difficulty from '../models/Difficulty.js';
import cliProgress from 'cli-progress';
import colors from 'ansi-colors';

// Constants for cache maagement
const CACHE_BATCH_SIZE = 200;
const CACHE_UPDATE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
// Progress bar for cache updates
const progressBar = new cliProgress.SingleBar(
  {
    format: colors.cyan('{bar}') + ' | {percentage}% | Cache Update | {status}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
  },
  cliProgress.Presets.shades_classic,
);

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
  score12KRank: number;
}

export class LeaderboardCache {
  private cache: Map<string, any[]>;
  private lastUpdate: Date;
  private updateInterval: number;
  private isUpdating: boolean;
  private updateTimeout: NodeJS.Timeout | null = null;
  private readonly UPDATE_DELAY = 2 * 60 * 1000; // 2 minutes in milliseconds
  private static instance: LeaderboardCache;
  private abortController: AbortController | null;
  private updatePromise: Promise<void> | null;

  private constructor() {
    this.cache = new Map();
    this.lastUpdate = new Date(0);
    this.updateInterval = 5 * 60 * 1000; // 5 minutes
    this.isUpdating = false;
    this.abortController = null;
    this.updatePromise = null;

    // Handle process termination
    process.on('SIGINT', () => this.handleShutdown());
    process.on('SIGTERM', () => this.handleShutdown());
  }

  private async handleShutdown() {
    if (this.isUpdating) {
      this.abortController?.abort();
      if (this.updateTimeout) {
        clearTimeout(this.updateTimeout);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Cache update aborted');
  }

  private async loadPlayersInBatches(signal: AbortSignal): Promise<Player[]> {
    const allPlayers: Player[] = [];
    let offset = 0;

    while (!signal.aborted) {
      try {
        const batchPlayers = await Player.findAll({
          include: [
            {
              model: Pass,
              as: 'passes',
              include: [
                {
                  model: Level,
                  as: 'level',
                  include: [
                    {
                      model: Difficulty,
                      as: 'difficulty',
                    },
                  ],
                },
              ],
            },
          ],
          limit: CACHE_BATCH_SIZE,
          offset: offset,
          order: [['id', 'ASC']],
        });

        if (batchPlayers.length === 0) break;
        allPlayers.push(...batchPlayers);
        offset += CACHE_BATCH_SIZE;

        // Update progress
        const progress = Math.min(
          100,
          (offset / (offset + CACHE_BATCH_SIZE)) * 100,
        );
        progressBar.update(progress, {
          status: `Loading players (${allPlayers.length} loaded)`,
        });
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
    signal: AbortSignal,
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
              status: `Processing players (${start + index + 1}/${total})`,
            });
            return enriched;
          } catch (error) {
            console.error(`Error processing player ${player.id}:`, error);
            return null;
          }
        }),
      );

      // Filter out failed entries
      return enrichedPlayers.filter(
        (player): player is IPlayer => player !== null,
      );
    } catch (error) {
      console.error('Batch processing error:', error);
      return [];
    }
  }

  private async updateCache(): Promise<void> {
    if (this.isUpdating) {
      return this.updatePromise || Promise.resolve();
    }

    this.isUpdating = true;
    this.updatePromise = this._updateCache();
    return this.updatePromise;
  }

  private async _updateCache(): Promise<void> {
    this.abortController = new AbortController();
    progressBar.start(100, 0, {status: 'Starting cache update'});

    try {
      // Set overall timeout
      this.updateTimeout = setTimeout(() => {
        this.abortController?.abort();
      }, CACHE_UPDATE_TIMEOUT);

      // Get total count first
      const totalCount = await Player.count();
      const totalBatches = Math.ceil(totalCount / CACHE_BATCH_SIZE);
      const batchPromises: Promise<IPlayer[]>[] = [];

      // Create promises for all batches
      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        if (this.abortController.signal.aborted) break;

        const batchPromise = (async () => {
          try {
            // Load and process batch in one go
            const batchPlayers = await Player.findAll({
              include: [
                {
                  model: Pass,
                  as: 'passes',
                  include: [
                    {
                      model: Level,
                      as: 'level',
                      include: [
                        {
                          model: Difficulty,
                          as: 'difficulty',
                        },
                      ],
                    },
                  ],
                },
              ],
              limit: CACHE_BATCH_SIZE,
              offset: batchIndex * CACHE_BATCH_SIZE,
              order: [['id', 'ASC']],
            });

            // Process the batch
            const enrichedBatch = await Promise.all(
              batchPlayers.map(async player => {
                try {
                  return await enrichPlayerData(player);
                } catch (error) {
                  console.error(`Error processing player ${player.id}:`, error);
                  return null;
                }
              }),
            );

            // Update progress
            const progress = Math.min(
              95,
              ((batchIndex + 1) / totalBatches) * 95,
            );
            progressBar.update(progress, {
              status: `Processing batch ${batchIndex + 1}/${totalBatches}`,
            });

            return enrichedBatch.filter(
              (player): player is IPlayer => player !== null,
            );
          } catch (error) {
            console.error(`Error processing batch ${batchIndex}:`, error);
            return [];
          }
        })();

        batchPromises.push(batchPromise);
      }

      // Wait for all batches to complete
      const batchResults = await Promise.all(batchPromises);
      if (this.abortController.signal.aborted) {
        throw new Error('Cache update aborted');
      }

      // Combine all results
      const enrichedPlayers = batchResults.flat();

      // Update cache with processed players
      const sortOptions = [
        'rankedScore',
        'generalScore',
        'ppScore',
        'wfScore',
        'score12K',
      ];
      const orders = ['asc', 'desc'];
      const includeScoresOptions = [true, false];

      progressBar.update(95, {status: 'Updating cache entries'});

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
            /* eslint-disable @typescript-eslint/no-unused-vars */
            const finalPlayers = includeScores
              ? sortedPlayers
              : sortedPlayers.map(({passes, ...player}) => player);

            const key = this.getCacheKey(sortBy, order, includeScores);
            this.cache.set(key, finalPlayers);
          }
        }
      }

      this.lastUpdate = new Date();
      progressBar.update(100, {status: 'Cache update complete'});
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'Cache update aborted') {
        console.log('Cache update aborted');
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
      this.updatePromise = null;
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
    const key = this.getCacheKey(sortBy, order, includeAllScores);

    // Return stale data if we have it
    const staleData = this.cache.get(key) || [];

    // Start update in background if needed
    if (this.needsUpdate()) {
      this.updateCache().catch(error => {
        console.error('Background cache update failed:', error);
      });
    }

    return staleData;
  }

  public async getRanks(playerId: number): Promise<PlayerRanks> {
    // Use stale data for ranks too
    const ranks: PlayerRanks = {
      rankedScoreRank: 0,
      generalScoreRank: 0,
      ppScoreRank: 0,
      wfScoreRank: 0,
      score12KRank: 0,
    };

    const rankedScoreLeaderboard = await this.get('rankedScore', 'desc', false);
    const generalScoreLeaderboard = await this.get(
      'generalScore',
      'desc',
      false,
    );
    const ppScoreLeaderboard = await this.get('ppScore', 'desc', false);
    const wfScoreLeaderboard = await this.get('wfScore', 'desc', false);
    const score12KLeaderboard = await this.get('score12K', 'desc', false);

    ranks.rankedScoreRank =
      rankedScoreLeaderboard.findIndex(p => p.id === playerId) + 1;
    ranks.generalScoreRank =
      generalScoreLeaderboard.findIndex(p => p.id === playerId) + 1;
    ranks.ppScoreRank =
      ppScoreLeaderboard.findIndex(p => p.id === playerId) + 1;
    ranks.wfScoreRank =
      wfScoreLeaderboard.findIndex(p => p.id === playerId) + 1;
    ranks.score12KRank =
      score12KLeaderboard.findIndex(p => p.id === playerId) + 1;

    const totalPlayers = rankedScoreLeaderboard.length;
    ranks.rankedScoreRank = ranks.rankedScoreRank || totalPlayers + 1;
    ranks.generalScoreRank = ranks.generalScoreRank || totalPlayers + 1;
    ranks.ppScoreRank = ranks.ppScoreRank || totalPlayers + 1;
    ranks.wfScoreRank = ranks.wfScoreRank || totalPlayers + 1;
    ranks.score12KRank = ranks.score12KRank || totalPlayers + 1;

    return ranks;
  }

  public async initialize() {
    return this.updateCache();
  }

  public async forceUpdate(immediate = true): Promise<void> {
    // Clear any pending scheduled update
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
      this.updateTimeout = null;
    }

    if (immediate) {
      return this._updateCache();
    } else {
      this.scheduleUpdate();
      return Promise.resolve();
    }
  }

  public scheduleUpdate(): void {
    // Clear any existing timeout
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }

    // Set a new timeout
    this.updateTimeout = setTimeout(async () => {
      try {
        await this._updateCache();
      } catch (error) {
        console.error('Error in scheduled cache update:', error);
      } finally {
        this.updateTimeout = null;
      }
    }, this.UPDATE_DELAY);
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
