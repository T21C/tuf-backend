import PlayerStats from '../models/players/PlayerStats.js';
import Player from '../models/players/Player.js';
import Pass from '../models/passes/Pass.js';
import Level from '../models/levels/Level.js';
import Difficulty from '../models/levels/Difficulty.js';
import sequelize from '../config/db.js';
import {sseManager} from '../utils/sse.js';
import User from '../models/auth/User.js';
import Judgement from '../models/passes/Judgement.js';
import { escapeForMySQL } from '../utils/searchHelpers.js';
import { Op, QueryTypes } from 'sequelize';
import { ModifierService } from '../services/ModifierService.js';
import { logger } from '../utils/logger.js';

// Define operation types for the queue
type QueueOperation = {
  type: 'reloadAllStats' | 'updatePlayerStats' | 'updateRanks';
  params?: any;
  priority?: number;
};

export class PlayerStatsService {
  private static instance: PlayerStatsService;
  private isInitialized = false;
  private readonly RELOAD_INTERVAL = 10 * 60 * 1000; // 10 minutes
  private readonly CHUNK_SIZE = 500; // Reduced from 2000 to 500 to lower memory usage
  private readonly BATCHES_PER_CHUNK = 4; // Number of batches to split each chunk into
  private modifierService: ModifierService | null = null;
  private updating = false;
  private operationQueue: QueueOperation[] = [];
  private isProcessingQueue = false;
  private readonly MEMORY_THRESHOLD = 0.8; // 80% of available memory
  private readonly MAX_MEMORY_USAGE = 700; // 700MB max memory usage
  private statsQuery = 
  `
  WITH PassesData AS (
    SELECT 
      p.playerId, 
      p.levelId, 
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
      this.reloadAllStatsCron();
      this.isInitialized = true;
    } catch (error) {
      console.error('Error initializing PlayerStatsService:', error);
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
    logger.debug(`[PlayerStatsService] Adding operation to queue: ${operation.type}`);
    
    // Add operation to queue with priority (lower number = higher priority)
    this.operationQueue.push({
      ...operation,
      priority: operation.priority || 10
    });
    
    // Sort queue by priority
    this.operationQueue.sort((a, b) => (a.priority || 10) - (b.priority || 10));
    
    // Start processing queue if not already processing
    if (!this.isProcessingQueue) {
      this.processQueue();
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
        if (!this.checkMemoryUsage()) {
          // If memory usage is too high, wait a bit before continuing
          logger.warn('Memory usage too high. Waiting 30 seconds before continuing...');
          await new Promise(resolve => setTimeout(resolve, 30000));
          continue;
        }
        
        const operation = this.operationQueue.shift();
        if (!operation) continue;
        
        logger.debug(`[PlayerStatsService] Processing queue operation: ${operation.type}`);
        
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

  // Add memory monitoring function
  private checkMemoryUsage(): boolean {
    const used = process.memoryUsage();
    const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024);
    const rssMB = Math.round(used.rss / 1024 / 1024);
    
    logger.debug(`Memory usage: ${heapUsedMB}MB / ${heapTotalMB}MB (${rssMB}MB RSS)`);
    
    // Check if memory usage is too high
    if (heapUsedMB > this.MAX_MEMORY_USAGE) {
      logger.warn(`Memory usage too high (${heapUsedMB}MB). Pausing processing.`);
      return false;
    }
    
    return true;
  }

  // Rename existing methods to private implementation methods
  private async _reloadAllStats(): Promise<void> {
    logger.debug(`[PlayerStatsService] Starting reloadAllStats`);

    if (this.updating) {
      logger.warn(`[PlayerStatsService] reloadAllStats called while updating, skipping`);
      return;
    }
    this.updating = true;
    const playerCount = await Player.count();
    
    // Process in smaller chunks to reduce memory pressure
    const BATCH_SIZE = Math.ceil(this.CHUNK_SIZE / this.BATCHES_PER_CHUNK);
    
    logger.debug(`[PlayerStatsService] Processing in chunks of ${this.CHUNK_SIZE} with ${this.BATCHES_PER_CHUNK} batches per chunk`);
    let timeStart = Date.now();
    for (let chunkStart = 0; chunkStart < playerCount; chunkStart += this.CHUNK_SIZE) {
      // Check memory usage before processing each chunk
      if (!this.checkMemoryUsage()) {
        logger.warn('Memory usage too high. Waiting 60 seconds before continuing...');
        await new Promise(resolve => setTimeout(resolve, 60000));
        continue;
      }
      
      const chunkEnd = Math.min(chunkStart + this.CHUNK_SIZE, playerCount);

      // Get IDs for this chunk
      const chunkPlayerIds = await Player.findAll({
        attributes: ['id'],
        order: [['id', 'ASC']],
        offset: chunkStart,
        limit: chunkEnd - chunkStart,
      });
      
      const playerIds = chunkPlayerIds.map(player => player.id);
      logger.debug(`[PlayerStatsService] Found ${playerIds.length} player IDs in current chunk`);

      // Process this chunk in batches
      for (let i = 0; i < playerIds.length; i += BATCH_SIZE) {
        // Check memory usage before processing each batch
        if (!this.checkMemoryUsage()) {
          logger.warn('Memory usage too high. Waiting 30 seconds before continuing...');
          await new Promise(resolve => setTimeout(resolve, 30000));
          continue;
        }
        
        const batchIds = playerIds.slice(i, i + BATCH_SIZE);
        let batchTimeStart = Date.now();
 
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
            `SELECT id, sortOrder FROM difficulties WHERE type = 'PGU'`,
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
              lastUpdated: new Date(),
              createdAt: new Date(),
              updatedAt: new Date()
            }));
            
            await PlayerStats.bulkCreate(emptyStats, { transaction });
            logger.debug(`[PlayerStatsService] Created empty stats for ${emptyStats.length} players without passes`);
          }
          
          await transaction.commit();
          logger.debug(`[PlayerStatsService] Successfully processed batch ${Math.floor(i/BATCH_SIZE) + 1} of ${Math.ceil(playerIds.length/BATCH_SIZE)} in current chunk in ${Date.now() - batchTimeStart}ms`);

        } catch (error) {
          this.updating = false;
          console.error(`[PlayerStatsService] FAILURE: Error processing batch:`, error);
          try {
            await transaction.rollback();
            logger.debug(`[PlayerStatsService] Successfully rolled back batch transaction`);
          } catch (rollbackError) {
            console.error(`[PlayerStatsService] FAILURE: Error rolling back batch transaction:`, rollbackError);
          }
        }
      }
    }
    
    // After all batches are processed, update ranks in a single transaction
    try {
      await this._updateRanks();
      logger.debug(`[PlayerStatsService] Successfully updated ranks`);
    } catch (error) {
      this.updating = false;
      console.error('[PlayerStatsService] FAILURE: Error updating ranks:', error);
    }
    this.updating = false;
    // Emit SSE event
    sseManager.broadcast({
      type: 'statsUpdate',
      data: {
        action: 'fullReload',
      },
    });
    logger.debug(`[PlayerStatsService] Successfully completed reloadAllStats in ${Date.now() - timeStart}ms`);
  }

  private async _updatePlayerStats(
    playerIds: number[]
  ): Promise<void> {
    logger.debug(`[PlayerStatsService] Starting updatePlayerStats`);

    if (this.updating) {
      logger.warn(`[PlayerStatsService] updatePlayerStats called while updating, skipping`);
      return;
    }
    
    // Check if playerIds is empty
    if (!playerIds || playerIds.length === 0) {
      logger.warn(`[PlayerStatsService] updatePlayerStats called with empty playerIds array, skipping`);
      this.updating = false;
      return;
    }
    
    // Check memory usage before processing
    if (!this.checkMemoryUsage()) {
      logger.warn('Memory usage too high. Skipping updatePlayerStats');
      return;
    }
    
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
            `SELECT id, sortOrder FROM difficulties WHERE type = 'PGU'`,
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
              lastUpdated: new Date(),
              createdAt: new Date(),
              updatedAt: new Date()
            }));
            
            await PlayerStats.bulkCreate(emptyStats, { transaction });
            logger.debug(`[PlayerStatsService] Created empty stats for ${emptyStats.length} players without passes`);
          }
          
          await transaction.commit();

        } catch (error) {
          this.updating = false;
          console.error(`[PlayerStatsService] FAILURE: Error processing batch:`, error);
          try {
            await transaction.rollback();
            logger.debug(`[PlayerStatsService] Successfully rolled back batch transaction`);
          } catch (rollbackError) {
            console.error(`[PlayerStatsService] FAILURE: Error rolling back batch transaction:`, rollbackError);
          }
        }
      
    
    // After all batches are processed, update ranks in a single transaction
    try {
      await this._updateRanks();
      logger.debug(`[PlayerStatsService] Successfully updated ranks`);
    } catch (error) {
      this.updating = false;
      console.error('[PlayerStatsService] FAILURE: Error updating ranks:', error);
    }

    // Emit SSE event
    sseManager.broadcast({
      type: 'statsUpdate',
      data: {
        action: 'fullReload',
      },
    });
    this.updating = false;
    logger.debug(`[PlayerStatsService] Successfully completed updatePlayerStats`);
  }

  private async _updateRanks(): Promise<void> {
    logger.debug('[PlayerStatsService] Starting updateRanks');
    
    // Check memory usage before processing
    if (!this.checkMemoryUsage()) {
      logger.warn('Memory usage too high. Skipping updateRanks');
      return;
    }
    
    const transaction = await sequelize.transaction();
    try {
      // First, set all ranks to -1 for banned players
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

      // Initialize rank counter
      await sequelize.query('SET @rank = 0', { transaction });

      // Update ranks for active players using MySQL variables
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
         SET ps.rankedScoreRank = ranked.rank_num,
             ps.generalScoreRank = ranked.rank_num,
             ps.ppScoreRank = ranked.rank_num,
             ps.wfScoreRank = ranked.rank_num,
             ps.score12KRank = ranked.rank_num`,
        { transaction }
      );

      await transaction.commit();
      logger.debug('[PlayerStatsService] Successfully committed rank updates');

      // Notify clients about the rank updates
      sseManager.broadcast({
        type: 'ranksUpdate',
        data: {
          action: 'update'
        }
      });
    } catch (error) {
      console.error('[PlayerStatsService] FAILURE: Error in updateRanks:', error);
      try {
        await transaction.rollback();
        logger.debug('[PlayerStatsService] Successfully rolled back rank updates');
      } catch (rollbackError) {
        console.error('[PlayerStatsService] FAILURE: Error rolling back rank updates:', rollbackError);
      }
      throw error;
    }
  }

  // Public methods that use the queue
  public async reloadAllStats(): Promise<void> {
    logger.debug(`[PlayerStatsService] Queueing reloadAllStats operation`);
    await this.addToQueue({ type: 'reloadAllStats', priority: 1 });
  }

  public async updatePlayerStats(
    playerIds: number[]
  ): Promise<void> {
    logger.debug(`[PlayerStatsService] Queueing updatePlayerStats operation`);
    await this.addToQueue({ 
      type: 'updatePlayerStats', 
      params: playerIds,
      priority: 2
    });
  }

  public async updateRanks(): Promise<void> {
    logger.debug(`[PlayerStatsService] Queueing updateRanks operation`);
    await this.addToQueue({ type: 'updateRanks', priority: 3 });
  }

  private async reloadAllStatsCron() {
    logger.debug('Setting up cron for full stats reload');
    setInterval(async () => {
      await this.reloadAllStats();
    }, this.RELOAD_INTERVAL);
  }

  public async getPlayerStats(playerId: number): Promise<PlayerStats | null> {
    const playerStats = await PlayerStats.findOne({
      attributes: {
        include: [
          [
            sequelize.literal(`(
              SELECT COUNT(*) 
              FROM passes 
              JOIN levels ON levels.id = passes.levelId 
              WHERE passes.playerId = PlayerStats.id
              AND passes.isDeleted = false 
              AND levels.isDeleted = false
            )`),
            'totalPasses',
          ],
        ],
      },
      where: {id: playerId},
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
              attributes: ['avatarUrl'],
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

    if (!playerStats) return null;

    const plainStats = playerStats.get({plain: true});
    return {
      ...plainStats,
      id: plainStats.player.id,
      rank: plainStats.rankedScoreRank,
      player: {
        ...plainStats.player,
        pfp: plainStats.player.user?.avatarUrl || plainStats.player.pfp || null,
      },
    };
  }

  public async getLeaderboard(
    sortBy = 'rankedScore',
    order: 'asc' | 'desc' = 'desc',
    showBanned: 'show' | 'hide' | 'only' = 'show',
    playerId?: number,
    offset = 0,
    limit = 30,
    nameQuery?: string
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
        whereClause[Op.and] = [
          { '$player.isBanned$': false },
          { [Op.or]: [
            { '$player->user.id$': null },
            { '$player->user.isEmailVerified$': true }
          ] }
        ];
      } else if (showBanned === 'only') {
        whereClause[Op.or] = [
          { '$player.isBanned$': true },
          { [Op.and]: [
            { '$player->user.id$': { [Op.not]: null } },
            { '$player->user.isEmailVerified$': false }
          ] }
        ];
      }

      // Add player ID filter if provided
      if (playerId) {
        whereClause['$player.id$'] = playerId;
      }

      const escapedQuery = nameQuery ? escapeForMySQL(nameQuery) : '';
      // Add name search if provided
      if (nameQuery && !nameQuery.startsWith('#')) {
        whereClause['$player.name$'] = sequelize.where(
          sequelize.fn('LOWER', sequelize.col('player.name')),
          'LIKE',
          `%${escapedQuery.toLowerCase()}%`
        );
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
        totalPasses: {
          field: sequelize.literal(
            '(SELECT COUNT(*) FROM passes ' +
            'JOIN levels ON levels.id = passes.levelId ' +
            'WHERE passes.playerId = player.id ' + 
            'AND passes.isDeleted = false ' +
            'AND levels.isDeleted = false)'
          ),
          rankField: null,
        },
        universalPassCount: {field: 'universalPassCount', rankField: null},
        worldsFirstCount: {field: 'worldsFirstCount', rankField: null},
        topDiffId: {field: 'topDiffId', rankField: null},
        top12kDiffId: {field: 'top12kDiffId', rankField: null},
      };

      const sortInfo = sortFieldMap[sortBy] || sortFieldMap['rankedScore'];
      const orderField = sortInfo.field;
      const orderItem: [any, string] = [orderField, order.toUpperCase()];

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
        attributes: {
          include: [
            [sortFieldMap['totalPasses'].field, 'totalPasses'],
            [sortFieldMap['topDiffId'].field, 'topDiffId'],
            [sortFieldMap['top12kDiffId'].field, 'top12kDiffId'],
          ],
        },
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
                attributes: ['avatarUrl', 'username', 'isEmailVerified'],
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
        where: whereClause,
        order: [orderItem, ['id', 'DESC']],
        offset,
        limit
      });

      if (sortBy === 'topDiff' || sortBy === 'top12kDiff') {
        players.sort((a, b) => {
          const diffA = a.topDiff?.sortOrder || 0;
          const diffB = b.topDiff?.sortOrder || 0;
          return diffB - diffA;
        });
      }

      // Map the results
      const mappedPlayers = players.map(player => {
        const plainPlayer = player.get({plain: true});
        return {
          ...plainPlayer,
          id: plainPlayer.player.id,
          rank: plainPlayer.rankedScoreRank,
          player: {
            ...plainPlayer.player,
            pfp: plainPlayer.player.user?.avatarUrl || plainPlayer.player.pfp || null,
            isEmailVerified: plainPlayer.player.user?.isEmailVerified ?? true,
          }
        };
      });

      return {
        total,
        players: mappedPlayers
      };
    } catch (error) {
      console.error('Error in getLeaderboard:', error);
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
          where: !user?.isSuperAdmin ? {
            isDeleted: false
          } : {},
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
            },
          ],
        },
        {
          model: Judgement,
          as: 'judgements',
        },
      ],
    });
    
    const topScores = await sequelize.query(`
      SELECT 
        p.id,
        p.scoreV2
      FROM player_pass_summary p
      WHERE p.playerId = :playerId
      ORDER BY p.scoreV2 DESC
      LIMIT 20
      `, {
        replacements: {
          playerId: pass?.player?.id || 0
        },
        type: QueryTypes.SELECT,
      }) as {id: number, scoreV2: number}[];

    if (!pass) {
      return null;
    }

    const currentStats = await PlayerStatsService.getInstance().getPlayerStats(pass.player?.id || 0);
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
    const playerStats = await this.getPlayerStats(pass.player?.id || 0);

    const response = {
      ...pass.toJSON(),
      player: {
        ...pass.player?.toJSON(),
        discordUsername: pass.player?.user?.username,
        avatarUrl: pass.player?.user?.avatarUrl,
        pfp: pass.player?.pfp || null,
      },
      scoreInfo: {
        currentRankedScore: currentStats?.rankedScore,
        previousRankedScore: previousStats?.rankedScore,
        impact,
        impactRank: topScores.findIndex(score => score.id === passId) + 1
      },
      ranks: {
        rankedScoreRank: playerStats?.rankedScoreRank,
      },
    };

    return response;
  }

}
