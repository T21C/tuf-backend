import PlayerStats from '../../models/players/PlayerStats.js';
import Player from '../../models/players/Player.js';
import Pass from '../../models/passes/Pass.js';
import Level from '../../models/levels/Level.js';
import Difficulty from '../../models/levels/Difficulty.js';
import sequelize from '../../config/db.js';
import {sseManager} from '../../misc/utils/server/sse.js';
import User from '../../models/auth/User.js';
import Judgement from '../../models/passes/Judgement.js';
import { escapeForMySQL } from '../../misc/utils/data/searchHelpers.js';
import { Op, QueryTypes } from 'sequelize';
import { ModifierService } from './ModifierService.js';
import { logger } from './LoggerService.js';
import { IPlayer } from '../interfaces/models/index.js';
import { OAuthProvider } from '../../models/index.js';
import Creator from '../../models/credits/Creator.js';
import { safeTransactionRollback } from '../../misc/utils/Utility.js';
import { hasFlag } from '../../misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '../../config/constants.js';
import LevelCredit from '../../models/levels/LevelCredit.js';
import Team from '../../models/credits/Team.js';
// Define operation types for the queue
type QueueOperation = {
  type: 'reloadAllStats' | 'updatePlayerStats' | 'updateRanks';
  params?: any;
  priority?: number;
};

type EnrichedPlayer = IPlayer & {
  topScores: {id: number, impact: number}[];
  potentialTopScores: {id: number, impact: number}[];
  uniquePasses: Map<number, Pass>;
  stats: PlayerStats | null;
  username?: string;
  user?: {
    id: string;
    username: string;
    nickname?: string | null;
    avatarUrl?: string | null;
    isSuperAdmin: boolean;
    isRater: boolean;
    permissionFlags: bigint;
    playerId: number;
    creator?: {
      id: number;
      name: string;
      isVerified: boolean;
    } | null;
  } | null;
}

export class PlayerStatsService {
  private static instance: PlayerStatsService;
  private isInitialized = false;
  private readonly RELOAD_INTERVAL = 30 * 60 * 1000; // 30 minutes
  private readonly CHUNK_SIZE = 200; // Reduced from 2000 to 500 to lower memory usage
  private readonly BATCHES_PER_CHUNK = 4; // Number of batches to split each chunk into
  private readonly DEBOUNCE_DELAY = 2 * 60 * 1000; // 2 minutes in milliseconds
  private modifierService: ModifierService | null = null;
  private updating = false;
  private operationQueue: QueueOperation[] = [];
  private isProcessingQueue = false;
  private pendingPlayerIds: Set<number> = new Set();
  private debounceTimer: NodeJS.Timeout | null = null;
  private statsQuery =
  `
  WITH PassesData AS (
    SELECT 
      p.playerId, 
      p.levelId, 
      p.availability_status,
      MAX(p.isWorldsFirst) as isWorldsFirst,
      MAX(p.is12K) as is12K,
      MAX(p.accuracy) as accuracy,
      MAX(p.scoreV2) as scoreV2
    FROM player_pass_summary p
    WHERE p.playerId IN (:playerIds)
    AND (:excludedLevelIds IS NULL OR p.levelId NOT IN (:excludedLevelIds))
    AND (:excludedPassIds IS NULL OR p.id NOT IN (:excludedPassIds))
    GROUP BY p.playerId, p.levelId
  ),
  GeneralPassesData AS (
    SELECT 
      p.playerId, 
      p.levelId, 
      p.availability_status,
      SUM(p.scoreV2) as levelScore
    FROM player_pass_summary p
    WHERE p.playerId IN (:playerIds)
    AND (:excludedLevelIds IS NULL OR p.levelId NOT IN (:excludedLevelIds))
    AND (:excludedPassIds IS NULL OR p.id NOT IN (:excludedPassIds))
    GROUP BY p.playerId, p.levelId
  ),
  RankedScores AS (
    SELECT 
      p.playerId,
      p.scoreV2,
      ROW_NUMBER() OVER (PARTITION BY p.playerId ORDER BY p.scoreV2 DESC) as rank_num
    FROM PassesData p
    WHERE p.availability_status != 'Not Available'
  ),
  RankedScoreCalc AS (
    SELECT 
      rs.playerId,
      SUM(rs.scoreV2 * POW(0.9, rs.rank_num - 1)) as rankedScore
    FROM RankedScores rs
    WHERE rs.rank_num <= 20
    GROUP BY rs.playerId
  ),
  GeneralScoreCalc AS (
    SELECT 
      p.playerId,
      SUM(p.levelScore) as generalScore
    FROM GeneralPassesData p
    GROUP BY p.playerId
  ),
  PPScoreCalc AS (
    SELECT 
      p.playerId,
      SUM(p.scoreV2) as ppScore
    FROM PassesData p
    WHERE p.accuracy = 1.0
    GROUP BY p.playerId
  ),
  WFScoreCalc AS (
    SELECT 
      p.playerId,
      SUM(ps.baseScore) as wfScore
    FROM PassesData p
    JOIN player_pass_summary ps ON p.playerId = ps.playerId AND p.levelId = ps.levelId
    WHERE p.isWorldsFirst = true
    GROUP BY p.playerId
  ),
  Score12KCalc AS (
    SELECT 
      ranked.playerId,
      SUM(ranked.scoreV2 * POW(0.9, ranked.rank_num - 1)) as score12K
    FROM (
      SELECT 
        p.playerId,
        p.scoreV2,
        ROW_NUMBER() OVER (PARTITION BY p.playerId ORDER BY p.scoreV2 DESC) as rank_num
      FROM PassesData p
      WHERE p.is12K = true
    ) ranked
    WHERE ranked.rank_num <= 20
    GROUP BY ranked.playerId
  ),
  AverageXaccCalc AS (
    SELECT 
      ranked.playerId,
      AVG(ranked.accuracy) as averageXacc
    FROM (
      SELECT 
        p.playerId,
        p.accuracy,
        ROW_NUMBER() OVER (PARTITION BY p.playerId ORDER BY p.scoreV2 DESC) as rank_num
      FROM PassesData p
    ) ranked
    WHERE ranked.rank_num <= 20
    GROUP BY ranked.playerId
  ),
  UniversalPassCountCalc AS (
    SELECT 
      p.playerId,
      COUNT(DISTINCT p.levelId) as universalPassCount
    FROM PassesData p
    JOIN player_pass_summary ps ON p.playerId = ps.playerId AND p.levelId = ps.levelId
    WHERE ps.name LIKE 'U%'
    AND ps.type = 'PGU'
    GROUP BY p.playerId
  ),
  WorldsFirstCountCalc AS (
    SELECT 
      p.playerId,
      COUNT(*) as worldsFirstCount
    FROM PassesData p
    WHERE p.isWorldsFirst = true
    GROUP BY p.playerId
  ),
  TopDiffId AS (
    SELECT 
      p.playerId,
      MAX(ps.sortOrder) as maxSortOrder
    FROM PassesData p
    JOIN player_pass_summary ps ON p.playerId = ps.playerId AND p.levelId = ps.levelId
    WHERE ps.type = 'PGU'
    GROUP BY p.playerId
  ),
  TopDiff12kId AS (
    SELECT 
      p.playerId,
      MAX(ps.sortOrder) as maxSortOrder
    FROM PassesData p
    JOIN player_pass_summary ps ON p.playerId = ps.playerId AND p.levelId = ps.levelId
    WHERE ps.type = 'PGU'
    AND p.is12K = true
    GROUP BY p.playerId
  ),
  TotalPassesCalc AS (
    SELECT 
      p.playerId,
      COUNT(*) as totalPasses
    FROM PassesData p
    GROUP BY p.playerId
  )
  SELECT 
    p.playerId as id,
    COALESCE(rs.rankedScore, 0) as rankedScore,
    COALESCE(gs.generalScore, 0) as generalScore,
    COALESCE(ps.ppScore, 0) as ppScore,
    COALESCE(wfs.wfScore, 0) as wfScore,
    COALESCE(s12k.score12K, 0) as score12K,
    COALESCE(axc.averageXacc, 0) as averageXacc,
    COALESCE(upc.universalPassCount, 0) as universalPassCount,
    COALESCE(wfc.worldsFirstCount, 0) as worldsFirstCount,
    COALESCE(tdi.maxSortOrder, 0) as topDiffId,
    COALESCE(td12k.maxSortOrder, 0) as top12kDiffId,
    COALESCE(tpc.totalPasses, 0) as totalPasses,
    NOW() as lastUpdated,
    NOW() as createdAt,
    NOW() as updatedAt
  FROM (SELECT DISTINCT playerId FROM PassesData) p
  LEFT JOIN RankedScoreCalc rs ON rs.playerId = p.playerId
  LEFT JOIN GeneralScoreCalc gs ON gs.playerId = p.playerId
  LEFT JOIN PPScoreCalc ps ON ps.playerId = p.playerId
  LEFT JOIN WFScoreCalc wfs ON wfs.playerId = p.playerId
  LEFT JOIN Score12KCalc s12k ON s12k.playerId = p.playerId
  LEFT JOIN AverageXaccCalc axc ON axc.playerId = p.playerId
  LEFT JOIN UniversalPassCountCalc upc ON upc.playerId = p.playerId
  LEFT JOIN WorldsFirstCountCalc wfc ON wfc.playerId = p.playerId
  LEFT JOIN TopDiffId tdi ON tdi.playerId = p.playerId
  LEFT JOIN TopDiff12kId td12k ON td12k.playerId = p.playerId
  LEFT JOIN TotalPassesCalc tpc ON tpc.playerId = p.playerId
  `


  private constructor() {
    this.modifierService = ModifierService.getInstance();
  }

  public setModifiersEnabled(enabled: boolean): void {
    if (this.modifierService) {
      this.modifierService.setModifiersEnabled(enabled);
    }
  }

  public isModifiersEnabled(): boolean {
    if (this.modifierService) {
      return this.modifierService.isModifiersEnabled();
    }
    return false;
  }

  public async initialize() {
    if (this.isInitialized) return;

    try {
      await this.reloadAllStats();
      await this.reloadAllStatsCron();
      this.isInitialized = true;
    } catch (error) {
      logger.error('Error initializing PlayerStatsService:', error);
      // Don't set isInitialized to true if there was an error
    }
  }

  public static getInstance(): PlayerStatsService {
    if (!PlayerStatsService.instance) {
      PlayerStatsService.instance = new PlayerStatsService();
    }
    return PlayerStatsService.instance;
  }

  // Add queue processing methods
  private async addToQueue(operation: QueueOperation): Promise<void> {
    // logger.debug(`[PlayerStatsService] Adding operation to queue: ${operation.type}`);

    // Add operation to queue with priority (lower number = higher priority)
    this.operationQueue.push({
      ...operation,
      priority: operation.priority || 10
    });

    // Sort queue by priority
    this.operationQueue.sort((a, b) => (a.priority || 10) - (b.priority || 10));

    // Start processing queue if not already processing
    if (!this.isProcessingQueue) {
      await this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.operationQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (this.operationQueue.length > 0) {
        // Check memory usage before processing each operation
        // checkMemoryUsage()

        const operation = this.operationQueue.shift();
        if (!operation) continue;

        // logger.debug(`[PlayerStatsService] Processing queue operation: ${operation.type}`);

        try {
          switch (operation.type) {
            case 'reloadAllStats':
              await this._reloadAllStats();
              break;
            case 'updatePlayerStats':
              await this._updatePlayerStats(operation.params);
              break;
            case 'updateRanks':
              await this._updateRanks();
              break;
          }
        } catch (error) {
          logger.error(`[PlayerStatsService] Error processing queue operation ${operation.type}:`, error);
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  // Rename existing methods to private implementation methods
  private async _reloadAllStats(): Promise<void> {
    const startTime = Date.now();
    //logger.debug(`[PlayerStatsService] Starting full stats reload`);

    if (this.updating) {
      //logger.warn(`[PlayerStatsService] Reload already in progress, skipping`);
      return;
    }
    this.updating = true;
    const playerCount = await Player.count();
    //logger.debug(`[PlayerStatsService] Processing ${playerCount} players`);

    // Process in smaller chunks to reduce memory pressure
    const BATCH_SIZE = Math.ceil(this.CHUNK_SIZE / this.BATCHES_PER_CHUNK);



    for (let chunkStart = 0; chunkStart < playerCount; chunkStart += this.CHUNK_SIZE) {
      const chunkEnd = Math.min(chunkStart + this.CHUNK_SIZE, playerCount);

      // Get IDs for this chunk
      const chunkPlayerIds = await Player.findAll({
        attributes: ['id'],
        order: [['id', 'ASC']],
        offset: chunkStart,
        limit: chunkEnd - chunkStart,
      });

      const playerIds = chunkPlayerIds.map(player => player.id);

      // Process this chunk in batches
      for (let i = 0; i < playerIds.length; i += BATCH_SIZE) {
        const batchIds = playerIds.slice(i, i + BATCH_SIZE);

        // Use a single transaction for the entire batch
        const transaction = await sequelize.transaction();
        try {
          // First, delete existing stats for these players
          await PlayerStats.destroy({
            where: { id: batchIds },
            transaction
          });

          // Calculate all stats in a single query
          const statsUpdates = await sequelize.query(this.statsQuery,
            {
              replacements: {
                playerIds: batchIds,
                excludedLevelIds: null,
                excludedPassIds: null
              },
              type: QueryTypes.SELECT,
              transaction
            }
          ) as any[];

          // Create a lookup table for difficulty IDs
          const difficultyLookup = await sequelize.query(
            'SELECT id, sortOrder FROM difficulties WHERE type = \'PGU\'',
            { type: QueryTypes.SELECT }
          ) as { id: number, sortOrder: number }[];

          // Create a map of sortOrder to id for quick lookups
          const sortOrderToIdMap = new Map<number, number>();
          difficultyLookup.forEach(diff => {
            sortOrderToIdMap.set(diff.sortOrder, diff.id);
          });

          // Process the stats updates to add the correct difficulty IDs
          if (statsUpdates.length > 0) {
            // Add the correct difficulty IDs based on sort order
            statsUpdates.forEach(stat => {
                stat.topDiffId = sortOrderToIdMap.get(stat.topDiffId) || 0;
                stat.top12kDiffId = sortOrderToIdMap.get(stat.top12kDiffId) || 0;
            });

            // Bulk insert all stats in a single query
            await PlayerStats.bulkCreate(statsUpdates, { transaction });
          }

          // Create stats for players who don't have any passes
          const playersWithStats = new Set(statsUpdates.map(stat => stat.id));
          const playersWithoutStats = batchIds.filter(id => !playersWithStats.has(id));

          if (playersWithoutStats.length > 0) {
            const emptyStats = playersWithoutStats.map(id => ({
              id,
              rankedScore: 0,
              generalScore: 0,
              ppScore: 0,
              wfScore: 0,
              score12K: 0,
              averageXacc: 0,
              universalPassCount: 0,
              worldsFirstCount: 0,
              topDiffId: 0,
              top12kDiffId: 0,
              totalPasses: 0,
              lastUpdated: new Date(),
              createdAt: new Date(),
              updatedAt: new Date()
            }));

            await PlayerStats.bulkCreate(emptyStats, { transaction });
          }

          await transaction.commit();

        } catch (error) {
          this.updating = false;
          logger.error('[PlayerStatsService] Batch processing failed:', error);
          await safeTransactionRollback(transaction);
        }
      }

    }

    // After all batches are processed, update ranks in a single transaction
    try {
      await this._updateRanks();
    } catch (error) {
      this.updating = false;
      logger.error('[PlayerStatsService] Failed to update ranks:', error);
    }

    this.updating = false;
    // Emit SSE event
    sseManager.broadcast({
      type: 'statsUpdate',
      data: {
        action: 'fullReload',
      },
    });

    const totalDuration = Date.now() - startTime;
    logger.debug(`[PlayerStatsService] Full stats reload for ${playerCount} players completed in ${totalDuration}ms`);
    //logger.debug(`[PlayerStatsService] Batch statistics: ${successfulBatches}/${totalBatches} successful, ${failedBatches} failed`);
  }

  private async _updatePlayerStats(
    playerIds: number[]
  ): Promise<void> {
    const startTime = Date.now();

    if (this.updating) {
      return;
    }

    // Check if playerIds is empty
    if (!playerIds || playerIds.length === 0) {
      this.updating = false;
      return;
    }
    logger.debug(`[PlayerStatsService] Starting stats update for ${playerIds.length} players`);

    this.updating = true;
    // Use a single transaction for the entire batch
    const transaction = await sequelize.transaction();
    try {
      // First, delete existing stats for these players
      await PlayerStats.destroy({
        where: { id: playerIds },
        transaction
      });

      // Calculate all stats in a single query
      const statsUpdates = await sequelize.query(this.statsQuery,
        {
          replacements: {
            playerIds,
            excludedLevelIds: null,
            excludedPassIds: null
          },
          type: QueryTypes.SELECT,
          transaction
        }
      ) as any[];

      // Create a lookup table for difficulty IDs
      const difficultyLookup = await sequelize.query(
        'SELECT id, sortOrder FROM difficulties WHERE type = \'PGU\'',
        { type: QueryTypes.SELECT }
      ) as { id: number, sortOrder: number }[];

      // Create a map of sortOrder to id for quick lookups
      const sortOrderToIdMap = new Map<number, number>();
      difficultyLookup.forEach(diff => {
        sortOrderToIdMap.set(diff.sortOrder, diff.id);
      });

      // Process the stats updates to add the correct difficulty IDs
      if (statsUpdates.length > 0) {
        // Add the correct difficulty IDs based on sort order
        statsUpdates.forEach(stat => {
            stat.topDiffId = sortOrderToIdMap.get(stat.topDiffId) || 0;
            stat.top12kDiffId = sortOrderToIdMap.get(stat.top12kDiffId) || 0;
        });

        // Bulk insert all stats in a single query
        await PlayerStats.bulkCreate(statsUpdates, { transaction });
      }

      // Create stats for players who don't have any passes
      const playersWithStats = new Set(statsUpdates.map(stat => stat.id));
      const playersWithoutStats = playerIds.filter(id => !playersWithStats.has(id));

      if (playersWithoutStats.length > 0) {
        const emptyStats = playersWithoutStats.map(id => ({
          id,
          rankedScore: 0,
          generalScore: 0,
          ppScore: 0,
          wfScore: 0,
          score12K: 0,
          averageXacc: 0,
          universalPassCount: 0,
          worldsFirstCount: 0,
          topDiffId: 0,
          top12kDiffId: 0,
          totalPasses: 0,
          lastUpdated: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        }));

        await PlayerStats.bulkCreate(emptyStats, { transaction });
      }

      await transaction.commit();
      logger.debug(`[PlayerStatsService] Stats updated for ${statsUpdates.length} players with stats, ${playersWithoutStats.length} players without stats`);

    } catch (error) {
      this.updating = false;
      logger.error('[PlayerStatsService] Failed to update player stats:', error);
      await safeTransactionRollback(transaction);
    }

    // After all batches are processed, update ranks in a single transaction
    try {
      await this._updateRanks();
    } catch (error) {
      this.updating = false;
      logger.error('[PlayerStatsService] Failed to update ranks:', error);
    }

    // Emit SSE event
    sseManager.broadcast({
      type: 'statsUpdate',
      data: {
        action: 'fullReload',
      },
    });

    this.updating = false;
    const totalDuration = Date.now() - startTime;
    logger.debug(`[PlayerStatsService] Player stats update completed in ${totalDuration}ms`);
  }

  private async _updateRanks(): Promise<void> {
    // logger.debug(`[PlayerStatsService] Starting rank updates`);

    const transaction = await sequelize.transaction();
    try {
      // Update rankedScoreRank
      await sequelize.query('SET @rank = 0', { transaction });
      await sequelize.query(
        `UPDATE player_stats ps 
         INNER JOIN players p ON ps.id = p.id 
         INNER JOIN (
           SELECT id, (@rank := @rank + 1) as rank_num
           FROM (
             SELECT ps2.id
             FROM player_stats ps2
             INNER JOIN players p2 ON ps2.id = p2.id
             WHERE p2.isBanned = false
             ORDER BY ps2.rankedScore DESC, ps2.id ASC
           ) ordered
         ) ranked ON ps.id = ranked.id
         SET ps.rankedScoreRank = ranked.rank_num`,
        { transaction }
      );

      // Update generalScoreRank
      await sequelize.query('SET @rank = 0', { transaction });
      await sequelize.query(
        `UPDATE player_stats ps 
         INNER JOIN players p ON ps.id = p.id 
         INNER JOIN (
           SELECT id, (@rank := @rank + 1) as rank_num
           FROM (
             SELECT ps2.id
             FROM player_stats ps2
             INNER JOIN players p2 ON ps2.id = p2.id
             WHERE p2.isBanned = false
             ORDER BY ps2.generalScore DESC, ps2.id ASC
           ) ordered
         ) ranked ON ps.id = ranked.id
         SET ps.generalScoreRank = ranked.rank_num`,
        { transaction }
      );

      // Update ppScoreRank
      await sequelize.query('SET @rank = 0', { transaction });
      await sequelize.query(
        `UPDATE player_stats ps 
         INNER JOIN players p ON ps.id = p.id 
         INNER JOIN (
           SELECT id, (@rank := @rank + 1) as rank_num
           FROM (
             SELECT ps2.id
             FROM player_stats ps2
             INNER JOIN players p2 ON ps2.id = p2.id
             WHERE p2.isBanned = false
             ORDER BY ps2.ppScore DESC, ps2.id ASC
           ) ordered
         ) ranked ON ps.id = ranked.id
         SET ps.ppScoreRank = ranked.rank_num`,
        { transaction }
      );

      // Update wfScoreRank
      await sequelize.query('SET @rank = 0', { transaction });
      await sequelize.query(
        `UPDATE player_stats ps 
         INNER JOIN players p ON ps.id = p.id 
         INNER JOIN (
           SELECT id, (@rank := @rank + 1) as rank_num
           FROM (
             SELECT ps2.id
             FROM player_stats ps2
             INNER JOIN players p2 ON ps2.id = p2.id
             WHERE p2.isBanned = false
             ORDER BY ps2.wfScore DESC, ps2.id ASC
           ) ordered
         ) ranked ON ps.id = ranked.id
         SET ps.wfScoreRank = ranked.rank_num`,
        { transaction }
      );

      // Update score12KRank
      await sequelize.query('SET @rank = 0', { transaction });
      await sequelize.query(
        `UPDATE player_stats ps 
         INNER JOIN players p ON ps.id = p.id 
         INNER JOIN (
           SELECT id, (@rank := @rank + 1) as rank_num
           FROM (
             SELECT ps2.id
             FROM player_stats ps2
             INNER JOIN players p2 ON ps2.id = p2.id
             WHERE p2.isBanned = false
             ORDER BY ps2.score12K DESC, ps2.id ASC
           ) ordered
         ) ranked ON ps.id = ranked.id
         SET ps.score12KRank = ranked.rank_num`,
        { transaction }
      );

      await sequelize.query(
        `UPDATE player_stats ps 
         INNER JOIN players p ON ps.id = p.id 
         SET ps.rankedScoreRank = -1,
             ps.generalScoreRank = -1,
             ps.ppScoreRank = -1,
             ps.wfScoreRank = -1,
             ps.score12KRank = -1
         WHERE p.isBanned = true`,
        { transaction }
      );

      await transaction.commit();
      // logger.debug(`[PlayerStatsService] Rank updates completed in ${duration}ms`);

      // Notify clients about the rank updates
      sseManager.broadcast({
        type: 'ranksUpdate',
        data: {
          action: 'update'
        }
      });
    } catch (error) {
      logger.error('[PlayerStatsService] Failed to update ranks:', error);
      await safeTransactionRollback(transaction);
      throw error;
    }
  }

  // Public methods that use the queue
  public async reloadAllStats(): Promise<void> {
    // logger.debug(`[PlayerStatsService] Queueing reloadAllStats operation`);
    await this.addToQueue({ type: 'reloadAllStats', priority: 1 });
  }

  private async handleDebouncedUpdate(): Promise<void> {
    if (this.pendingPlayerIds.size === 0) return;

    const playerIds = Array.from(this.pendingPlayerIds);
    this.pendingPlayerIds.clear();
    this.debounceTimer = null;

    await this.addToQueue({
      type: 'updatePlayerStats',
      params: playerIds,
      priority: 2
    });
  }

  public async updatePlayerStats(
    playerIds: number[]
  ): Promise<void> {
    // Add new player IDs to the pending set
    playerIds.forEach(id => this.pendingPlayerIds.add(id));

    // Clear existing timer if any
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Set new timer
    this.debounceTimer = setTimeout(async () => {
      await this.handleDebouncedUpdate();
    }, this.DEBOUNCE_DELAY);
  }

  public async updateRanks(): Promise<void> {
    // logger.debug(`[PlayerStatsService] Queueing updateRanks operation`);
    await this.addToQueue({ type: 'updateRanks', priority: 3 });
  }

  private async reloadAllStatsCron() {
    // logger.debug('Setting up cron for full stats reload');
    setInterval(async () => {
      await this.reloadAllStats();
    }, this.RELOAD_INTERVAL);
  }

  public async getPlayerStats(playerIds: number[] | number): Promise<PlayerStats[]> {
    playerIds = Array.isArray(playerIds) ? playerIds : [playerIds];
    const playerStats = await PlayerStats.findAll({
      where: {id: playerIds},
      include: [
        {
          model: Player,
          as: 'player',
          attributes: ['id', 'name', 'country', 'isBanned', 'pfp'],
          required: true,
          include: [
            {
              model: User,
              as: 'user',
              attributes: ['avatarUrl', 'username', 'nickname'],
              required: false,
            },
          ],
        },
        {
          model: Difficulty,
          as: 'topDiff',
        },
        {
          model: Difficulty,
          as: 'top12kDiff',
        },
      ],
    });

    if (!playerStats || playerStats.length === 0) return [];

    const plainStats = playerStats.map(stat => stat.get({plain: true}));
    return plainStats.map(stat => ({
      ...stat,
      id: stat.player.id,
      rank: stat.rankedScoreRank,
      player: {
        ...stat.player,
        pfp: stat.player.user?.avatarUrl || stat.player.pfp || null,
      },
    }));
  }

  public async getMaxFields(): Promise<any> {
    try {
      const maxValues = await PlayerStats.findOne({
        attributes: [
          [sequelize.fn('MAX', sequelize.col('rankedScore')), 'maxRankedScore'],
          [sequelize.fn('MAX', sequelize.col('generalScore')), 'maxGeneralScore'],
          [sequelize.fn('MAX', sequelize.col('ppScore')), 'maxPpScore'],
          [sequelize.fn('MAX', sequelize.col('wfScore')), 'maxWfScore'],
          [sequelize.fn('MAX', sequelize.col('score12K')), 'maxScore12K'],
          [sequelize.fn('MAX', sequelize.col('averageXacc')), 'maxAverageXacc'],
          [sequelize.fn('MAX', sequelize.col('totalPasses')), 'maxTotalPasses'],
          [sequelize.fn('MAX', sequelize.col('universalPassCount')), 'maxUniversalPassCount'],
          [sequelize.fn('MAX', sequelize.col('worldsFirstCount')), 'maxWorldsFirstCount'],
        ],
        raw: true
      });

      return maxValues || {};
    } catch (error) {
      logger.error('Error getting max fields:', error);
      return {};
    }
  }

  public async getLeaderboard(
    sortBy = 'rankedScore',
    order: 'asc' | 'desc' = 'desc',
    showBanned: 'show' | 'hide' | 'only' = 'show',
    playerId?: number,
    offset = 0,
    limit = 30,
    nameQuery?: string,
    filters?: Record<string, [number, number]>
  ): Promise<{ total: number; players: PlayerStats[] }> {
    if (playerId && playerId < 1) {
      return {
        total: 0,
        players: []
      };
    }
    try {
      const whereClause: any = {};

      // Modified to handle unverified users as banned
      if (showBanned === 'hide') {
        whereClause['rankedScoreRank'] = { [Op.and]: [
          { [Op.not]: 0 },
          { [Op.not]: -1 }
        ] };
      } else if (showBanned === 'only') {
        whereClause['rankedScoreRank'] = { [Op.and]: [
          -1,
          { [Op.not]: 0 }
        ] };
      }

      // Add player ID filter if provided
      if (playerId) {
        whereClause['$player.id$'] = playerId;
      }

      // Add country filter if provided
      logger.debug(`[PlayerStatsService] Filters: ${JSON.stringify(filters)}`);
      if (filters?.['country']) {
        whereClause['$player.country$'] = filters['country'];
      }

      const escapedQuery = nameQuery ? escapeForMySQL(nameQuery) : '';
      // Add name search if provided
      if (nameQuery && !nameQuery.startsWith('#')) {
        whereClause[Op.or] = [
          sequelize.where(
            sequelize.fn('LOWER', sequelize.col('player.name')),
            'LIKE',
            `%${escapedQuery.toLowerCase()}%`
          ),
          sequelize.where(
            sequelize.fn('LOWER', sequelize.col('player.user.username')),
            'LIKE',
            `%${escapedQuery.toLowerCase()}%`
          )
        ];
      }
      if (!nameQuery) {
        whereClause['totalPasses'] = { [Op.gt]: 0 };
      }

      // Apply filters if provided
      if (filters) {
        const filterFieldMap: Record<string, string> = {
          rankedScore: 'rankedScore',
          generalScore: 'generalScore',
          ppScore: 'ppScore',
          wfScore: 'wfScore',
          score12K: 'score12K',
          averageXacc: 'averageXacc',
          totalPasses: 'totalPasses',
          universalPassCount: 'universalPassCount',
          worldsFirstCount: 'worldsFirstCount'
        };

        Object.entries(filters).forEach(([key, [min, max]]) => {
          const fieldName = filterFieldMap[key];
          if (fieldName) {
            whereClause[fieldName] = {
              [Op.between]: [min, max]
            };
          }
        });
      }
      // Map frontend sort fields to database fields and their corresponding rank fields
      const sortFieldMap: {
        [key: string]: {field: any; rankField: string | null};
      } = {
        rankedScore: {field: 'rankedScore', rankField: 'rankedScoreRank'},
        generalScore: {field: 'generalScore', rankField: 'generalScoreRank'},
        ppScore: {field: 'ppScore', rankField: 'ppScoreRank'},
        wfScore: {field: 'wfScore', rankField: 'wfScoreRank'},
        score12K: {field: 'score12K', rankField: 'score12KRank'},
        averageXacc: {field: 'averageXacc', rankField: null},
        totalPasses: {field: 'totalPasses', rankField: null},
        universalPassCount: {field: 'universalPassCount', rankField: null},
        worldsFirstCount: {field: 'worldsFirstCount', rankField: null},
        topDiffId: {field: 'topDiffId', rankField: null},
        top12kDiffId: {field: 'top12kDiffId', rankField: null},
      };

      const sortInfo = sortFieldMap[sortBy] || sortFieldMap['rankedScore'];
      const orderField = sortInfo.field;

      // Determine order array based on sortBy
      let orderArray: any[];
      if (sortBy === 'topDiff') {
        orderArray = [
          // Correct Sequelize order tuple for association
          [{ model: Difficulty, as: 'topDiff' }, 'sortOrder', order],
          ['rankedScore', order],
          ['id', 'DESC']
        ];
      } else if (sortBy === 'top12kDiff') {
        orderArray = [
          [{ model: Difficulty, as: 'top12kDiff' }, 'sortOrder', order],
          ['rankedScore', order],
          ['id', 'DESC']
        ];
      }
      else if (sortBy === 'averageXacc') {
        orderArray = [
          ['averageXacc', order],
          ['rankedScore', order],
          ['id', 'DESC']
        ];
      }
      else {
        orderArray = [
          [orderField, order],
          ['id', 'DESC']
        ];
      }

      // Get total count first
      const total = await PlayerStats.count({
        include: [{
          model: Player,
          as: 'player',
          required: true,
          include: [
            {
              model: User,
              as: 'user',
              required: false,
            }
          ]
        }],
        where: whereClause
      });

      // Then get paginated results
      const players = await PlayerStats.findAll({
        include: [
          {
            model: Player,
            as: 'player',
            attributes: ['id', 'name', 'country', 'isBanned', 'pfp'],
            required: true,
            include: [
              {
                model: User,
                as: 'user',
                attributes: ['id', 'avatarUrl', 'username', 'permissionFlags'],
                required: false,
                include: [
                  {
                    model: Creator,
                    as: 'creator',
                    attributes: ['id', 'name', 'isVerified'],
                    required: false,
                  }
                ]
              },
            ],
          },
          {
            model: Difficulty,
            as: 'topDiff',
          },
          {
            model: Difficulty,
            as: 'top12kDiff',
          },
        ],
        where: whereClause,
        order: orderArray,
        offset,
        limit
      });

      // Remove in-memory sort for topDiff/top12kDiff

      // Map the results
      const mappedPlayers = players.map(player => {
        const plainPlayer = player.get({plain: true});
        return {
          ...plainPlayer,
          id: plainPlayer.player.id,
          rank: plainPlayer.rankedScoreRank,
          player: {
            ...plainPlayer.player,
            pfp: plainPlayer.player.user?.avatarUrl || plainPlayer.player.pfp || null
          }
        };
      });

      return {
        total,
        players: mappedPlayers
      };
    } catch (error) {
      logger.error('Error in getLeaderboard:', error);
      throw error;
    }
  }

  public async getPassDetails(passId: number, user?: any): Promise<any> {
    const pass = await Pass.findOne({
      where: {
        id: passId,
      },
      include: [
        {
          model: Player,
          as: 'player',
          include: [
            {
              model: User,
              as: 'user',
              attributes: ['username', 'avatarUrl'],
            },
          ],
        },
        {
          model: Level,
          as: 'level',
          where: !user || !hasFlag(user, permissionFlags.SUPER_ADMIN)  ? {
            isDeleted: false
          } : {},
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
            },
            {
              model: LevelCredit,
              as: 'levelCredits',
              include: [{
                model: Creator,
                as: 'creator',
              }],
            },
            {
              model: Team,
              as: 'teamObject'
            },
          ],
        },
        {
          model: Judgement,
          as: 'judgements',
        },
      ],
    });

    if (!pass) {
      return null;
    }

    // Check if pass is hidden and user is not the owner
    if (pass.isHidden && (!user || !user.playerId || pass.playerId !== user.playerId)) {
      // If user is not a super admin and doesn't own the pass, don't show it
      if (!user || !hasFlag(user, permissionFlags.SUPER_ADMIN)) {
        return null;
      }
    }

    const topScores = await sequelize.query(`
      SELECT 
        p.id,
        p.scoreV2
      FROM player_pass_summary p
      WHERE p.playerId = :playerId
      AND p.availability_status != 'Not Available'
      ORDER BY p.scoreV2 DESC
      LIMIT 20
      `, {
        replacements: {
          playerId: pass?.player?.id || 0
        },
        type: QueryTypes.SELECT,
      }) as {id: number, scoreV2: number}[];

    const currentStats = await sequelize.query(this.statsQuery, {
      replacements: {
        playerIds: [pass.player?.id || 0],
        excludedLevelIds: null,
        excludedPassIds: null,
      },
      type: QueryTypes.SELECT,
    }).then((result: any) => result[0])
    const previousStats = await sequelize.query(this.statsQuery, {
      replacements: {
        playerIds: [pass.player?.id || 0],
        excludedLevelIds: null,
        excludedPassIds: [passId]
      },
      type: QueryTypes.SELECT,
    }).then((result: any) => result[0]);



    const impact = (currentStats?.rankedScore || 0) - (previousStats?.rankedScore || 0);

    // Get player stats for rank
    const playerStats = await this.getPlayerStats(pass.player?.id || 0).then(stats => stats?.[0]);

    const response = {
      ...pass.toJSON(),
      player: {
        ...pass.player?.toJSON(),
        username: pass.player?.user?.username,
        avatarUrl: pass.player?.user?.avatarUrl,
        pfp: pass.player?.pfp || null,
      },
      scoreInfo: {
        currentRankedScore: currentStats?.rankedScore || 0,
        previousRankedScore: previousStats?.rankedScore || 0,
        impact: impact || 0,
        impactRank: topScores.findIndex(score => score.id === passId) + 1
      },
      ranks: {
        rankedScoreRank: playerStats?.rankedScoreRank,
      },
    };

    return response;
  }

  public async getEnrichedPlayer(playerId: number, user?: any): Promise<EnrichedPlayer | null> {

    const player = await Player.findByPk(playerId, {
      include: [
        {
          model: User,
          as: 'user',
        },
      ],
    });

    if (!player) return null;

    // Determine if we should include hidden passes (only for own profile)
    const includeHiddenPasses = user && user.playerId && user.playerId === playerId;

    // Build where clause for passes
    const passWhereClause: any = {
      playerId: playerId,
      isDeleted: false,
    };

    // If not own profile, exclude hidden passes
    if (!includeHiddenPasses) {
      passWhereClause.isHidden = false;
    }

    // Load all passes for these players in one query
    const allPasses = await Pass.findAll({
      where: passWhereClause,
      include: [
        {
          model: Level,
          as: 'level',
          where: {
            isDeleted: false,
          },
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
            },
            {
              model: LevelCredit,
              as: 'levelCredits',
              attributes: ['role'],
              include: [{
                model: Creator,
                as: 'creator',
                attributes: ['name'],
                required: false,
              }],
            }
          ],
        },
        {
          model: Judgement,
          as: 'judgements',
        },
      ],
    });

    // Load all user data in one query
    const allUserData = await User.findAll({
      where: {playerId: playerId},
      include: [
        {
          model: OAuthProvider,
          as: 'providers',
          where: {provider: 'discord'},
          attributes: ['profile'],
          required: false,
        },
        {
          model: Creator,
          as: 'creator',
          attributes: ['id', 'name', 'isVerified'],
          required: false,
        },
      ],
      attributes: ['id', 'playerId', 'nickname', 'avatarUrl', 'username', 'permissionFlags'],
    });

    // Create lookup maps for faster access
    const passesMap = new Map<number, Pass[]>();
    allPasses.forEach((pass: Pass) => {
      if (!passesMap.has(pass.playerId)) {
        passesMap.set(pass.playerId, []);
      }
      passesMap.get(pass.playerId)?.push(pass);
    });

    const userDataMap = new Map(
      allUserData.map((user: any) => [user.playerId, user]),
    );

    const playerStatsService = PlayerStatsService.getInstance();

    // Process each player with the pre-loaded data
        const playerData = player.get({plain: true});
        const passes = passesMap.get(player.id) || [];
        const userData = userDataMap.get(player.id) as any;

        // Process Discord data
        let discordProvider: any;
        if (userData?.dataValues?.providers?.length > 0) {
          discordProvider = userData.dataValues.providers[0].dataValues;
          discordProvider.profile.avatarUrl = discordProvider.profile.avatar
            ? `https://cdn.discordapp.com/avatars/${discordProvider.profile.id}/${discordProvider.profile.avatar}.png`
            : null;
        }

        // Get player stats from service
        const stats = await playerStatsService.getPlayerStats(player.id).then(stats => stats?.[0]);
        const uniquePasses = new Map();
        passes.forEach(pass => {
          if (
            !uniquePasses.has(pass.levelId) ||
            (pass.scoreV2 || 0) > (uniquePasses.get(pass.levelId).scoreV2 || 0)
          ) {
            uniquePasses.set(pass.levelId, pass);
          }
        });

        const isLevelAvailable = (level: Level) => {
          return level.isExternallyAvailable || level.dlLink || level.workshopLink;
        }

        const topScores = Array.from(uniquePasses.values())
          .filter((pass: any) => !pass.isDeleted && !pass.isDuplicate && isLevelAvailable(pass.level) && !pass.isHidden)
          .sort((a, b) => (b.scoreV2 || 0) - (a.scoreV2 || 0))
          .slice(0, 20)
          .map((pass, index) => ({
            id: pass.id,
            impact: (pass.scoreV2 || 0) * Math.pow(0.9, index),
          }));

        const potentialTopScores = Array.from(uniquePasses.values())
          .filter((pass: any) => !pass.isDeleted && !pass.isDuplicate && !pass.isHidden)
          .sort((a, b) => (b.scoreV2 || 0) - (a.scoreV2 || 0))
          .slice(0, 20)
          .map((pass, index) => ({
            id: pass.id,
            impact: (pass.scoreV2 || 0) * Math.pow(0.9, index),
          }));



        return {
          id: playerData.id,
          name: playerData.name,
          country: playerData.country,
          isBanned: playerData.isBanned || hasFlag(userData, permissionFlags.BANNED),
          isSubmissionsPaused: playerData.isSubmissionsPaused,
          pfp: playerData.pfp,
          avatarUrl: userData?.avatarUrl,
          username: userData?.username, // Changed from discordUsername to username
          discordUsername: discordProvider?.profile.username, // This is the actual Discord username
          discordAvatar: discordProvider?.profile.avatarUrl,
          discordAvatarId: discordProvider?.profile.avatar,
          discordId: discordProvider?.profile.id,
          user: userData ? {
            id: userData.id,
            username: userData.username,
            nickname: userData.nickname,
            avatarUrl: userData.avatarUrl,
            isSuperAdmin: hasFlag(userData, permissionFlags.SUPER_ADMIN),
            isRater: hasFlag(userData, permissionFlags.RATER),
            playerId: userData.playerId,
            permissionFlags: userData.permissionFlags.toString(),
            creator: userData.creator ? {
              id: userData.creator.id,
              name: userData.creator.name,
              isVerified: userData.creator.isVerified
            } : null
          } : null,
          rankedScore: stats?.rankedScore || 0,
          generalScore: stats?.generalScore || 0,
          ppScore: stats?.ppScore || 0,
          wfScore: stats?.wfScore || 0,
          score12K: stats?.score12K || 0,
          averageXacc: stats?.averageXacc || 0,
          universalPassCount: stats?.universalPassCount || 0,
          worldsFirstCount: stats?.worldsFirstCount || 0,
          topDiff: stats?.topDiff,
          top12kDiff: stats?.top12kDiff,
          totalPasses: stats?.totalPasses || 0,
          createdAt: playerData.createdAt,
          updatedAt: playerData.updatedAt,
          passes,
          topScores,
          potentialTopScores,
          uniquePasses,
          stats
    } as unknown as EnrichedPlayer
    }
  }
