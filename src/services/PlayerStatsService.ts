import PlayerStats from '../models/players/PlayerStats.js';
import Player from '../models/players/Player.js';
import Pass from '../models/passes/Pass.js';
import Level from '../models/levels/Level.js';
import Difficulty from '../models/levels/Difficulty.js';
import {IPass} from '../interfaces/models/index.js';
import {
  calculateRankedScore,
  calculateGeneralScore,
  calculatePPScore,
  calculateWFScore,
  calculate12KScore,
  calculateAverageXacc,
  countUniversalPassCount,
  countWorldsFirstPasses,
} from '../utils/PlayerStatsCalculator.js';
import sequelize from '../config/db.js';
import {getIO} from '../utils/socket.js';
import {sseManager} from '../utils/sse.js';
import User from '../models/auth/User.js';
import Judgement from '../models/passes/Judgement.js';
import { escapeForMySQL } from '../utils/searchHelpers.js';
import { Op, QueryTypes } from 'sequelize';
import { ModifierService } from '../services/ModifierService.js';
import { Transaction } from 'sequelize';
import { logger } from '../utils/logger.js';

export class PlayerStatsService {
  private static instance: PlayerStatsService;
  private isInitialized = false;
  private updateTimeout: NodeJS.Timeout | null = null;
  private readonly UPDATE_DELAY = 1 * 60 * 1000; // 1 minutes
  private readonly RELOAD_INTERVAL = 10 * 60 * 1000; // 1 minutes
  private readonly BATCH_SIZE = 500;
  private pendingPlayerIds: Set<number> = new Set();
  private modifierService: ModifierService | null = null;

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

  public scheduleUpdate(playerId: number): void {
    // Add player to pending updates
    this.pendingPlayerIds.add(playerId);

    // Clear any existing timeout
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }

    // Set a new timeout
    this.updateTimeout = setTimeout(async () => {
      try {
        const playerIds = Array.from(this.pendingPlayerIds);
        this.pendingPlayerIds.clear();

        // Start a transaction for all updates
        const transaction = await sequelize.transaction();

        try {
          // Update each player's stats
          for (const id of playerIds) {
            try {
              await this.updatePlayerStats(id, transaction);
            } catch (error) {
              console.error(`[PlayerStatsService] FAILURE: Error updating stats for player ${id}:`, error);
              // Continue with the next player even if this one fails
            }
          }

          // Update ranks for all players once
          try {
            await this.updateRanks(transaction);
          } catch (error) {
            console.error(`[PlayerStatsService] FAILURE: Error updating ranks for batch:`, error);
            // Continue with commit even if rank update fails
          }

          try {
            await transaction.commit();
          } catch (error) {
            console.error(`[PlayerStatsService] FAILURE: Error committing transaction for batch:`, error);
            try {
              await transaction.rollback();
            } catch (rollbackError) {
              console.error(`[PlayerStatsService] FAILURE: Error rolling back transaction for batch:`, rollbackError);
            }
          }
        } catch (error) {
          console.error(`[PlayerStatsService] FAILURE: Error in batch update for ${playerIds.length} players:`, error);
          try {
            await transaction.rollback();
          } catch (rollbackError) {
            console.error(`[PlayerStatsService] FAILURE: Error rolling back transaction for batch:`, rollbackError);
          }
        }
      } catch (error) {
        console.error('[PlayerStatsService] FAILURE: Error in scheduled stats update:', error);
      } finally {
        this.updateTimeout = null;
      }
    }, this.UPDATE_DELAY);
  }

  public async reloadAllStats(): Promise<void> {
    logger.debug(`[PlayerStatsService] Starting reloadAllStats`);
    // Clear any pending scheduled updates
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
      this.updateTimeout = null;
    }
    this.pendingPlayerIds.clear();

    // Proceed with the full reload
    const transaction = await sequelize.transaction();
    try {
      // First, get all player IDs in a deterministic order
      // Use a streaming approach to avoid loading all IDs into memory at once
      logger.debug(`[PlayerStatsService] Counting total players`);
      const playerCount = await Player.count({ transaction });
      logger.debug(`[PlayerStatsService] Found ${playerCount} total players`);
      
      // Process in smaller chunks to reduce memory pressure
      const CHUNK_SIZE = 5000; // Reduced from 10000 to 5000
      const BATCHES_PER_CHUNK = 20; // Each chunk will be divided into 20 batches
      const BATCH_SIZE = Math.ceil(CHUNK_SIZE / BATCHES_PER_CHUNK);
      
      logger.debug(`[PlayerStatsService] Processing in chunks of ${CHUNK_SIZE} with ${BATCHES_PER_CHUNK} batches per chunk`);
      
      for (let chunkStart = 0; chunkStart < playerCount; chunkStart += CHUNK_SIZE) {
        const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, playerCount);
        logger.debug(`[PlayerStatsService] Processing chunk ${Math.floor(chunkStart/CHUNK_SIZE) + 1} of ${Math.ceil(playerCount/CHUNK_SIZE)} (players ${chunkStart+1}-${chunkEnd})`);
        
        // Get IDs for this chunk
        const chunkPlayerIds = await Player.findAll({
          attributes: ['id'],
          order: [['id', 'ASC']],
          offset: chunkStart,
          limit: chunkEnd - chunkStart,
          transaction
        });
        
        const playerIds = chunkPlayerIds.map(player => player.id);
        logger.debug(`[PlayerStatsService] Found ${playerIds.length} player IDs in current chunk`);
        
        // Process this chunk in batches
        for (let i = 0; i < playerIds.length; i += BATCH_SIZE) {
          const batchIds = playerIds.slice(i, i + BATCH_SIZE);
          logger.debug(`[PlayerStatsService] Processing batch ${Math.floor(i/BATCH_SIZE) + 1} of ${Math.ceil(playerIds.length/BATCH_SIZE)} in current chunk`);
          
          // Use a separate transaction for each batch to reduce lock time
          const batchTransaction = await sequelize.transaction();
          try {
            await this.processBatchByIds(batchTransaction, batchIds);
            await batchTransaction.commit();
            logger.debug(`[PlayerStatsService] Successfully processed batch ${Math.floor(i/BATCH_SIZE) + 1} of ${Math.ceil(playerIds.length/BATCH_SIZE)} in current chunk`);
          } catch (error) {
            console.error(`[PlayerStatsService] FAILURE: Error processing batch:`, error);
            try {
              await batchTransaction.rollback();
              logger.debug(`[PlayerStatsService] Successfully rolled back batch transaction`);
            } catch (rollbackError) {
              console.error(`[PlayerStatsService] FAILURE: Error rolling back batch transaction:`, rollbackError);
            }
            // Continue with next batch even if this one failed
          }
          
          // Hint to garbage collector to clean up after each batch
          if (global.gc) {
            global.gc();
          }
        }
        
        // Hint to garbage collector to clean up after each chunk
        if (global.gc) {
          global.gc();
        }
      }
      
      try {
        await transaction.commit();
        logger.debug(`[PlayerStatsService] Successfully committed main transaction in reloadAllStats`);
        this.forceUpdateRanks();
        // Emit SSE event
        sseManager.broadcast({
          type: 'statsUpdate',
          data: {
            action: 'fullReload',
          },
        });
        logger.debug(`[PlayerStatsService] Successfully completed reloadAllStats`);
      } catch (error) {
        console.error('[PlayerStatsService] FAILURE: Error committing transaction in reloadAllStats:', error);
        try {
          await transaction.rollback();
          logger.debug(`[PlayerStatsService] Successfully rolled back main transaction in reloadAllStats`);
        } catch (rollbackError) {
          console.error('[PlayerStatsService] FAILURE: Error rolling back transaction in reloadAllStats:', rollbackError);
        }
        throw error;
      }
    } catch (error) {
      console.error('[PlayerStatsService] FAILURE: Error in reloadAllStats:', error);
      try {
        await transaction.rollback();
        logger.debug(`[PlayerStatsService] Successfully rolled back main transaction in reloadAllStats`);
      } catch (rollbackError) {
        console.error('[PlayerStatsService] FAILURE: Error rolling back transaction in reloadAllStats:', rollbackError);
      }
      throw error;
    }
  }

  private async processBatchByIds(transaction: Transaction, playerIds: number[]): Promise<void> {
    // Process players in smaller sub-batches to reduce lock contention
    const SUB_BATCH_SIZE = 100;
    
    for (let i = 0; i < playerIds.length; i += SUB_BATCH_SIZE) {
      const subBatchIds = playerIds.slice(i, i + SUB_BATCH_SIZE);
      
      // Use a separate transaction for each sub-batch
      const subBatchTransaction = await sequelize.transaction();
      try {
        // Get player data for this sub-batch
        const players = await Player.findAll({
          where: { id: subBatchIds },
          transaction: subBatchTransaction,
          lock: true // Use row-level locking to prevent concurrent updates
        });
        
        // Process each player in the sub-batch
        for (const player of players) {
          try {
            await this.calculatePlayerStats(player.id, subBatchTransaction);
          } catch (error) {
            console.error(`[PlayerStatsService] FAILURE: Error calculating stats for player ${player.id}:`, error);
            // Continue with next player even if this one failed
          }
        }
        
        await subBatchTransaction.commit();
      } catch (error) {
        console.error(`[PlayerStatsService] FAILURE: Error processing sub-batch:`, error);
        try {
          await subBatchTransaction.rollback();
        } catch (rollbackError) {
          console.error(`[PlayerStatsService] FAILURE: Error rolling back sub-batch transaction:`, rollbackError);
        }
        // Continue with next sub-batch even if this one failed
      }
    }
  }

  /**
   * Calculate stats for a single player
   * @param playerId The ID of the player to calculate stats for
   * @param transaction The transaction to use for database operations
   */
  private async calculatePlayerStats(playerId: number, transaction: Transaction): Promise<void> {
    // Get player with their passes in a single query
    const player = await Player.findOne({
      where: { id: playerId },
      include: [
        {
          model: Pass,
          as: 'passes',
          where: {
            isDeleted: false,
          },
          include: [
            {
              model: Level,
              as: 'level',
              where: {
                isDeleted: false
              },
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
        },
        {
          model: User,
          as: 'user',
          required: false,
        },
      ],
      transaction,
      subQuery: false,
    });

    if (!player) {
      return;
    }

    // Calculate top difficulties
    const {topDiffId, top12kDiffId} = this.calculatetopDiffIds(
      player.passes || [],
    );
    
    // Create base stats object
    const baseStats = {
      id: player.id,
      rankedScore: calculateRankedScore(player.passes || []),
      generalScore: calculateGeneralScore(player.passes || []),
      ppScore: calculatePPScore(player.passes || []),
      wfScore: calculateWFScore(player.passes || []),
      score12K: calculate12KScore(player.passes || []),
      averageXacc: calculateAverageXacc(player.passes || []),
      universalPassCount: countUniversalPassCount(player.passes || []),
      worldsFirstCount: countWorldsFirstPasses(player.passes || []),
      topDiffId,
      top12kDiffId,
      lastUpdated: new Date(),
    };

    // Apply modifiers if enabled
    const stats = this.modifierService 
      ? await this.modifierService.applyScoreModifiers(player.id, baseStats)
      : baseStats;

    // Upsert the stats
    await PlayerStats.upsert(stats, { transaction });
  }

  public getHighestScorePerLevel(scores: IPass[]): IPass[] {
    const levelScores = new Map<number, IPass>();
    scores.forEach(pass => {
      const levelId = pass.levelId;
      if (!levelId) return;

      const existingScore = levelScores.get(levelId);
      if (!existingScore || pass.scoreV2 && existingScore.scoreV2 && pass.scoreV2 > existingScore.scoreV2) {
        levelScores.set(levelId, pass);
      }
    });
    return Array.from(levelScores.values());
  }

  public convertPassesToScores(passes: IPass[] | Pass[]): IPass[] {
    return (passes as any)
      .filter((pass: any) => 
        !pass.isDeleted 
        && !pass.isDuplicate
        && !pass.level?.isDeleted
      )
      .map((pass: any) => ({
        score: pass.scoreV2 || 0,
        baseScore: pass.level?.baseScore || 0,
        xacc: pass.accuracy || 0.95,
        speed: pass.speed || 1,
        isWorldsFirst: pass.isWorldsFirst || false,
        is12K: pass.is12K || false,
        isDeleted: pass.isDeleted || false,
        levelId: pass.levelId,
      }));
  }

  public calculatetopDiffIds(passes: Pass[] | IPass[]): {
    topDiffId: number;
    top12kDiffId: number;
  } {
    // Filter out deleted passes and those with difficulty ID >= 100
    const validPasses = (passes as any).filter(
      (pass: any) =>
        !pass.isDeleted &&
        pass.level?.difficulty?.id !== undefined &&
        pass.level.difficulty.type === 'PGU',
    );

    if (validPasses.length === 0) {
      return {topDiffId: 0, top12kDiffId: 0};
    }

    // Sort passes by difficulty sortOrder in descending order
    const sortedPasses = validPasses.sort((a: any, b: any) => {
      const diffA = a.level?.difficulty?.sortOrder || 0;
      const diffB = b.level?.difficulty?.sortOrder || 0;
      return diffB - diffA;
    });

    // Get highest difficulty ID for regular passes
    const topDiffId = sortedPasses[0]?.level?.difficulty?.id ?? 0;

    // Get highest difficulty ID for 12k passes
    const valid12kPasses = validPasses.filter(
      (pass: any) => pass.is12K && !pass.is16K,
    );

    const top12kDiffId =
      valid12kPasses.length > 0
        ? (valid12kPasses.sort((a: any, b: any) => {
            const diffA = a.level?.difficulty?.sortOrder || 0;
            const diffB = b.level?.difficulty?.sortOrder || 0;

            return diffB - diffA;
          })[0]?.level?.difficulty?.id ?? 0)
        : 0;

    return {topDiffId, top12kDiffId};
  }

  public async updatePlayerStats(
    playerId: number,
    existingTransaction?: any,
  ): Promise<void> {
    logger.debug(`[PlayerStatsService] Starting updatePlayerStats for player ${playerId}`);
    
    // If no transaction is provided, create a new one
    const transaction = existingTransaction || await sequelize.transaction();
    try {
      // Get player data with a separate transaction to avoid long locks
      const player = await Player.findOne({
        where: { id: playerId },
        include: [
          {
            model: Pass,
            as: 'passes',
            where: { isDeleted: false },
            include: [
              {
                model: Level,
                as: 'level',
                where: { isDeleted: false },
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
          },
        ],
        transaction,
        lock: true, // Use row-level locking
      });

      if (!player) {
        logger.debug(`[PlayerStatsService] Player ${playerId} not found`);
        return;
      }

      // Calculate stats in memory to minimize transaction time
      const {topDiffId, top12kDiffId} = this.calculatetopDiffIds(player.passes || []);
      
      const baseStats = {
        id: player.id,
        rankedScore: calculateRankedScore(player.passes || []),
        generalScore: calculateGeneralScore(player.passes || []),
        ppScore: calculatePPScore(player.passes || []),
        wfScore: calculateWFScore(player.passes || []),
        score12K: calculate12KScore(player.passes || []),
        averageXacc: calculateAverageXacc(player.passes || []),
        universalPassCount: countUniversalPassCount(player.passes || []),
        worldsFirstCount: countWorldsFirstPasses(player.passes || []),
        topDiffId,
        top12kDiffId,
        lastUpdated: new Date(),
      };

      // Apply modifiers if enabled
      const stats = this.modifierService 
        ? await this.modifierService.applyScoreModifiers(player.id, baseStats)
        : baseStats;

      // Use a separate transaction for the upsert to minimize lock time
      const upsertTransaction = await sequelize.transaction();
      try {
        await PlayerStats.upsert(stats, { 
          transaction: upsertTransaction,
        });
        await upsertTransaction.commit();
        logger.debug(`[PlayerStatsService] Successfully upserted stats for player ${playerId}`);
      } catch (error) {
        console.error(`[PlayerStatsService] FAILURE: Error upserting stats for player ${playerId}:`, error);
        try {
          await upsertTransaction.rollback();
          logger.debug(`[PlayerStatsService] Successfully rolled back upsert transaction for player ${playerId}`);
        } catch (rollbackError) {
          console.error(`[PlayerStatsService] FAILURE: Error rolling back upsert transaction for player ${playerId}:`, rollbackError);
        }
        throw error;
      }

      // Update ranks with a separate transaction
      const ranksTransaction = await sequelize.transaction();
      try {
        await this.updateRanks(ranksTransaction);
        await ranksTransaction.commit();
        logger.debug(`[PlayerStatsService] Successfully updated ranks after stats update for player ${playerId}`);
      } catch (error) {
        console.error(`[PlayerStatsService] FAILURE: Error updating ranks for player ${playerId}:`, error);
        try {
          await ranksTransaction.rollback();
          logger.debug(`[PlayerStatsService] Successfully rolled back ranks transaction for player ${playerId}`);
        } catch (rollbackError) {
          console.error(`[PlayerStatsService] FAILURE: Error rolling back ranks transaction for player ${playerId}:`, rollbackError);
        }
        throw error;
      }

      // If we created the transaction, commit it
      if (!existingTransaction) {
        await transaction.commit();
        logger.debug(`[PlayerStatsService] Successfully committed main transaction for player ${playerId}`);
      }

      // Notify clients about the update
      sseManager.broadcast({
        type: 'statsUpdate',
        data: {
          action: 'update',
          playerId,
        },
      });
    } catch (error) {
      console.error(`[PlayerStatsService] FAILURE: Error in updatePlayerStats for player ${playerId}:`, error);
      // If we created the transaction, roll it back
      if (!existingTransaction) {
        try {
          await transaction.rollback();
          logger.debug(`[PlayerStatsService] Successfully rolled back main transaction for player ${playerId}`);
        } catch (rollbackError) {
          console.error(`[PlayerStatsService] FAILURE: Error rolling back main transaction for player ${playerId}:`, rollbackError);
        }
      }
      throw error;
    }
  }

  private async reloadAllStatsCron() {
    logger.debug('Setting up cron for full stats reload');
    setInterval(async () => {
      await this.reloadAllStats();
    }, this.RELOAD_INTERVAL);
  }

  private async updateRanks(transaction?: any): Promise<void> {
    logger.debug(`[PlayerStatsService] Starting updateRanks`);
    try {
      // Get all players with their stats
      logger.debug(`[PlayerStatsService] Fetching all players with stats`);
      const players = await Player.findAll({
        include: [
          {
            model: PlayerStats,
            as: 'stats',
            required: true
          },
          {
            model: User,
            as: 'user',
            required: false
          }
        ],
        transaction
      });

      logger.debug(`[PlayerStatsService] Found ${players.length} players with stats`);

      // Separate banned and non-banned players
      const bannedPlayers = players.filter(player => 
        player.isBanned || (player.user && !player.user.isEmailVerified)
      );
      const activePlayers = players.filter(player => 
        !player.isBanned && (!player.user || player.user.isEmailVerified)
      );

      logger.debug(`[PlayerStatsService] Found ${bannedPlayers.length} banned players and ${activePlayers.length} active players`);

      // Set rank to -1 for banned players
      if (bannedPlayers.length > 0) {
        logger.debug(`[PlayerStatsService] Setting rank to -1 for ${bannedPlayers.length} banned players`);
        const bannedIds = bannedPlayers.map(p => p.id);
        try {
          // Use a separate transaction for banned players to avoid long-running transactions
          const bannedTransaction = transaction || await sequelize.transaction();
          try {
            await sequelize.query(
              `
              UPDATE player_stats
              SET 
                rankedScoreRank = -1,
                generalScoreRank = -1,
                ppScoreRank = -1,
                wfScoreRank = -1,
                score12KRank = -1
              WHERE id IN (${bannedIds.join(',')})
              `,
              { transaction: bannedTransaction }
            );
            
            if (!transaction) {
              await bannedTransaction.commit();
              logger.debug(`[PlayerStatsService] Successfully updated ranks for banned players`);
            }
          } catch (error) {
            console.error('Error updating banned player ranks:', error);
            if (!transaction) {
              await bannedTransaction.rollback();
            }
            // Don't throw here, continue with the rest of the function
          }
        } catch (error) {
          console.error('Error creating transaction for banned players:', error);
          // Continue with the rest of the function
        }
      }

      // Calculate ranks for active players
      const scoreTypes = [
        'rankedScore',
        'generalScore',
        'ppScore',
        'wfScore',
        'score12K'
      ];

      for (const scoreType of scoreTypes) {
        const rankField = `${scoreType}Rank`;
        logger.debug(`[PlayerStatsService] Calculating ${rankField} for active players`);
        
        // Sort players by score in descending order
        const sortedPlayers = activePlayers
          .filter(player => player.stats && player.stats[scoreType as keyof PlayerStats] > 0)
          .sort((a, b) => {
            const scoreA = a.stats?.[scoreType as keyof PlayerStats] || 0;
            const scoreB = b.stats?.[scoreType as keyof PlayerStats] || 0;
            return scoreB - scoreA;
          });

        logger.debug(`[PlayerStatsService] Found ${sortedPlayers.length} players with ${scoreType} > 0`);

        // Update ranks in smaller batches with individual transactions
        const batchSize = 50; // Reduced batch size for better reliability
        for (let i = 0; i < sortedPlayers.length; i += batchSize) {
          const batch = sortedPlayers.slice(i, i + batchSize);
          const updates = batch.map((player, index) => {
            const rank = i + index + 1;
            return `WHEN id = ${player.id} THEN ${rank}`;
          }).join(' ');

          if (updates) {
            logger.debug(`[PlayerStatsService] Updating ${rankField} for batch ${i/batchSize + 1} of ${Math.ceil(sortedPlayers.length/batchSize)}`);
            
            // Create a new transaction for each batch
            const batchTransaction = transaction || await sequelize.transaction();
            try {
              await sequelize.query(
                `
                UPDATE player_stats
                SET ${rankField} = CASE ${updates} ELSE ${rankField} END
                WHERE id IN (${batch.map(p => p.id).join(',')})
                `,
                { transaction: batchTransaction }
              );
              
              if (!transaction) {
                await batchTransaction.commit();
                logger.debug(`[PlayerStatsService] Successfully updated ${rankField} for batch ${i/batchSize + 1}`);
              }
            } catch (error) {
              console.error(`Error updating ${rankField} for batch:`, error);
              if (!transaction) {
                try {
                  await batchTransaction.rollback();
                } catch (rollbackError) {
                  console.error(`Error rolling back transaction for ${rankField} batch:`, rollbackError);
                }
              }
              // Continue with next batch even if this one failed
            }
          }
        }
      }
      
      logger.debug(`[PlayerStatsService] Successfully completed updateRanks`);
    } catch (error) {
      console.error('Error updating ranks:', error);
      // Don't throw here, let the caller handle the transaction
    }
  }

  public async forceUpdateRanks(): Promise<void> {
    logger.debug(`[PlayerStatsService] Starting forceUpdateRanks`);
    try {
      // Use a separate transaction for the main operation
      const transaction = await sequelize.transaction();
      try {
        await this.updateRanks(transaction);
        try {
          await transaction.commit();
          logger.debug(`[PlayerStatsService] Successfully committed transaction in forceUpdateRanks`);
        } catch (error) {
          console.error('Error committing transaction in forceUpdateRanks:', error);
          try {
            await transaction.rollback();
          } catch (rollbackError) {
            console.error('Error rolling back transaction in forceUpdateRanks:', rollbackError);
          }
          throw error;
        }
      } catch (error) {
        console.error('Error updating ranks:', error);
        try {
          await transaction.rollback();
        } catch (rollbackError) {
          console.error('Error rolling back transaction in forceUpdateRanks:', rollbackError);
        }
        throw error;
      }
    } catch (error) {
      console.error('Error in forceUpdateRanks:', error);
      throw error;
    }
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

    if (!pass) {
      return null;
    }

    // Get player's passes for score calculation
    const playerPasses = await Pass.findAll({
      where: {
        playerId: pass.player?.id,
        isDeleted: false
      },
      include: [
        {
          model: Level,
          as: 'level',
          attributes: ['baseScore', 'id'],
          where: {
            isDeleted: false
          }
        },
        {
          model: Judgement,
          as: 'judgements',
        },
      ],
    });

    // Calculate unique passes and their impacts
    const uniquePasses = new Map();
    playerPasses.forEach(playerPass => {
      if (
        !uniquePasses.has(playerPass.levelId) ||
        (playerPass.scoreV2 || 0) > (uniquePasses.get(playerPass.levelId).scoreV2 || 0)
      ) {
        uniquePasses.set(playerPass.levelId, playerPass);
      }
    });

    const topScores = Array.from(uniquePasses.values())
      .filter((p: any) => !p.isDeleted && !p.isDuplicate)
      .sort((a, b) => (b.scoreV2 || 0) - (a.scoreV2 || 0))
      .slice(0, 20)
      .map((p, index) => ({
        id: p.id,
        impact: (p.scoreV2 || 0) * Math.pow(0.9, index),
      }));

    // Find this pass's impact position and value
    const passImpact = topScores.find(score => score.id === passId);

    // Calculate current and previous scores
    const currentRankedScore = calculateRankedScore(playerPasses);
    const previousRankedScore = calculateRankedScore(playerPasses.filter(p => p.id !== passId));

    const impact = currentRankedScore - previousRankedScore;

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
        currentRankedScore,
        previousRankedScore,
        impact,
        impactRank: passImpact ? topScores.findIndex(score => score.id === passId) + 1 : null
      },
      ranks: {
        rankedScoreRank: playerStats?.rankedScoreRank,
      },
    };

    return response;
  }
}
