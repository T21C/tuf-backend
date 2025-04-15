import PlayerStats from '../models/PlayerStats.js';
import Player from '../models/Player.js';
import Pass from '../models/Pass.js';
import Level from '../models/Level.js';
import Difficulty from '../models/Difficulty.js';
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
} from '../misc/PlayerStatsCalculator.js';
import sequelize from '../config/db.js';
import {getIO} from '../utils/socket.js';
import {sseManager} from '../utils/sse.js';
import User from '../models/User.js';
import Judgement from '../models/Judgement.js';
import { escapeForMySQL } from '../utils/searchHelpers.js';
import { Op, QueryTypes } from 'sequelize';
import PlayerModifier, { ModifierType } from '../models/PlayerModifier.js';
import { ModifierService } from '../services/ModifierService.js';

export class PlayerStatsService {
  private static instance: PlayerStatsService;
  private isInitialized = false;
  private updateTimeout: NodeJS.Timeout | null = null;
  private readonly UPDATE_DELAY = 2 * 60 * 1000; // 2 minutes
  private readonly RELOAD_INTERVAL = 4 * 60 * 1000; // 4 minutes
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
    // Clear any pending scheduled updates
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
      this.updateTimeout = null;
    }
    this.pendingPlayerIds.clear();

    // Proceed with the full reload
    let transaction;
    try {
      //console.log('[PlayerStatsService] Starting full stats reload');
      transaction = await sequelize.transaction();

      // Get all players with their passes in a single query
      const players = await Player.findAll({
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
                  isDeleted: false,
                  isHidden: false
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
      });

      //console.log(`[PlayerStatsService] Found ${players.length} players for stats reload`);

      // Check for players without passes
      const playersWithoutPasses = players.filter(player => !player.passes || player.passes.length === 0);
      if (playersWithoutPasses.length > 0) {
        //console.log(`[PlayerStatsService] Found ${playersWithoutPasses.length} players without passes`);
      }

      // Prepare bulk update data
      const bulkStats = await Promise.all(players.map(async (player: any) => {
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
        if (this.modifierService) {
          return this.modifierService.applyScoreModifiers(player.id, baseStats);
        }
        return baseStats;
      }));

      // Bulk upsert all stats
      try {
        await PlayerStats.bulkCreate(bulkStats, {
          updateOnDuplicate: [
            'rankedScore',
            'generalScore',
            'ppScore',
            'wfScore',
            'score12K',
            'averageXacc',
            'universalPassCount',
            'worldsFirstCount',
            'topDiffId',
            'top12kDiffId',
            'lastUpdated',
          ],
          transaction,
        });
      } catch (error) {
        console.error('[PlayerStatsService] FAILURE: Error bulk upserting stats:', error);
        throw error;
      }

      // Check for players who might have been missed
      const allPlayers = await Player.findAll({ 
        include: [
          {
            model: User,
            as: 'user',
            required: false,
          },
        ],
        transaction 
      });
      
      const playersWithStats = await PlayerStats.findAll({ transaction });
      
      const playerIdsWithStats = new Set(playersWithStats.map((p: any) => p.id));
      const playersWithoutStats = allPlayers.filter((p: any) => !playerIdsWithStats.has(p.id));
      
      if (playersWithoutStats.length > 0) {
        console.log(`[PlayerStatsService] Found ${playersWithoutStats.length} players without stats after bulk upsert`);
        
        // Create stats for these players
        const now = new Date();
        const missingStats = playersWithoutStats.map((player: any) => ({
          id: player.id,
          rankedScore: 0,
          generalScore: 0,
          ppScore: 0,
          wfScore: 0,
          score12K: 0,
          rankedScoreRank: 0,
          generalScoreRank: 0,
          ppScoreRank: 0,
          wfScoreRank: 0,
          score12KRank: 0,
          averageXacc: 0,
          universalPassCount: 0,
          worldsFirstCount: 0,
          lastUpdated: now,
          createdAt: now,
          updatedAt: now,
          topDiffId: 0,
          top12kDiffId: 0
        }));
        
        try {
          await PlayerStats.bulkCreate(missingStats, { transaction });
          console.log(`[PlayerStatsService] Created stats for ${missingStats.length} players who were missed`);
        } catch (error) {
          console.error('[PlayerStatsService] FAILURE: Error creating stats for missed players:', error);
          // Continue execution even if this fails
        }
      }

      // Update ranks in bulk for each score type
      const scoreTypes = [
        'rankedScore',
        'generalScore',
        'ppScore',
        'wfScore',
        'score12K',
      ];

      // First, identify all players that should be treated as banned
      // This includes players with isBanned=true and players with unverified users
      const bannedPlayers = await Player.findAll({
        include: [
          {
            model: User,
            as: 'user',
            required: false,
          }
        ],
        where: {
          [Op.or]: [
            { isBanned: true },
            { '$user.isEmailVerified$': false }
          ]
        },
        transaction
      });

      const bannedPlayerIds = bannedPlayers.map(player => player.id);

      // Update all rank fields for banned players to -1
      if (bannedPlayerIds.length > 0) {
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
            WHERE id IN (${bannedPlayerIds.join(',')})
            `,
            { transaction }
          );
        } catch (error) {
          console.error('[PlayerStatsService] FAILURE: Error updating banned player ranks:', error);
          // Continue execution even if this fails
        }
      }

      // For each score type, calculate ranks for non-banned players
      for (const scoreType of scoreTypes) {
        const rankField = `${scoreType}Rank`;
        
        // Get all eligible players (not in bannedPlayerIds) ordered by score
        const eligiblePlayers = await sequelize.query(
          `
          SELECT ps.id, ps.${scoreType}
          FROM player_stats ps
          WHERE ps.id NOT IN (${bannedPlayerIds.length > 0 ? bannedPlayerIds.join(',') : '0'})
          ORDER BY ps.${scoreType} DESC, ps.id ASC
          `,
          { 
            transaction,
            type: QueryTypes.SELECT
          }
        );
        
        if (!eligiblePlayers || eligiblePlayers.length === 0) {
          continue; // Skip if no eligible players found
        }

        // Create a map of player ID to rank
        const rankMap = new Map();
        eligiblePlayers.forEach((player: any, index: number) => {
          if (player && player.id) { // Only add valid player IDs
            rankMap.set(player.id, index + 1);
          }
        });
        
        // Update ranks in batches to avoid large transactions
        const batchSize = 1000;
        const eligibleIds = Array.from(rankMap.keys());
        
        for (let i = 0; i < eligibleIds.length; i += batchSize) {
          const batchIds = eligibleIds.slice(i, i + batchSize);
          if (batchIds.length === 0) continue;

          const updates = batchIds.map(id => {
            const rank = rankMap.get(id);
            return rank ? `WHEN id = ${id} THEN ${rank}` : null;
          }).filter(Boolean).join(' ');
          
          if (updates) {
            try {
              await sequelize.query(
                `
                UPDATE player_stats
                SET ${rankField} = CASE ${updates} ELSE ${rankField} END
                WHERE id IN (${batchIds.join(',')})
                `,
                { transaction }
              );
            } catch (error) {
              console.error(`[PlayerStatsService] FAILURE: Error updating ${rankField} for batch:`, error);
              // Continue with the next batch even if this one fails
            }
          }
        }
      }

      try {
        await transaction.commit();
        
        // Emit SSE event
        sseManager.broadcast({
          type: 'statsUpdate',
          data: {
            action: 'fullReload',
          },
        });
      } catch (error) {
        console.error('[PlayerStatsService] FAILURE: Error committing transaction in reloadAllStats:', error);
        try {
          await transaction.rollback();
        } catch (rollbackError) {
          console.error('[PlayerStatsService] FAILURE: Error rolling back transaction in reloadAllStats:', rollbackError);
        }
        throw error;
      }
    } catch (error) {
      console.error('[PlayerStatsService] FAILURE: Error in full stats reload:', error);
      if (transaction) {
        try {
          await transaction.rollback();
        } catch (rollbackError) {
          console.error('[PlayerStatsService] FAILURE: Error rolling back transaction in reloadAllStats:', rollbackError);
        }
      }
      throw error;
    }
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
        && !pass.level?.isHidden 
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
    const transaction = existingTransaction || (await sequelize.transaction());
    const shouldCommit = !existingTransaction;

    try {
      const player = await Player.findByPk(playerId, {
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
                  isDeleted: false,
                  isHidden: false
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
        ],
        transaction,
      });

      if (!player) {
        console.error(`[PlayerStatsService] FAILURE: Player ${playerId} not found when updating stats`);
        return;
      }

      if (!player.passes) {
        console.log(`[PlayerStatsService] Player ${playerId} has no passes, creating empty stats`);
      }

      // Convert passes to scores and get highest score per level

      // Calculate top difficulties
      const {topDiffId, top12kDiffId} = this.calculatetopDiffIds(
        player.passes || [],
      );

      // Calculate all scores using the filtered scores
      const stats = {
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

      // Update or create player stats
      try {
        await PlayerStats.upsert(stats, {transaction});
      } catch (error) {
        console.error(`[PlayerStatsService] FAILURE: Error upserting stats for player ${playerId}:`, error);
        throw error;
      }

      // Update ranks for all players
      try {
        await this.updateRanks(transaction);
      } catch (error) {
        console.error(`[PlayerStatsService] FAILURE: Error updating ranks for player ${playerId}:`, error);
        // Continue execution even if rank update fails
      }

      if (shouldCommit) {
        try {
          await transaction.commit();

          // Notify clients about the update
          const io = getIO();
          io.emit('leaderboardUpdated');

          // Emit SSE event
          sseManager.broadcast({
            type: 'statsUpdate',
            data: {
              id: player.id,
              newStats: stats,
            },
          });
        } catch (error) {
          console.error(`[PlayerStatsService] FAILURE: Error committing transaction for player ${playerId}:`, error);
          // If commit fails, try to rollback
          try {
            await transaction.rollback();
          } catch (rollbackError) {
            console.error(`[PlayerStatsService] FAILURE: Error rolling back transaction for player ${playerId}:`, rollbackError);
          }
          throw error;
        }
      }
    } catch (error) {
      console.error(`[PlayerStatsService] FAILURE: Error updating stats for player ${playerId}:`, error);
      if (shouldCommit) {
        try {
          await transaction.rollback();
        } catch (rollbackError) {
          console.error(`[PlayerStatsService] FAILURE: Error rolling back transaction for player ${playerId}:`, rollbackError);
        }
      }
      throw error;
    }
  }

  private async reloadAllStatsCron() {
    console.log('Setting up cron for full stats reload');
    setInterval(async () => {
      await this.reloadAllStats();
    }, this.RELOAD_INTERVAL);
  }

  private async updateRanks(transaction?: any): Promise<void> {
    try {
      // Get all players with their stats
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

      // Separate banned and non-banned players
      const bannedPlayers = players.filter(player => 
        player.isBanned || (player.user && !player.user.isEmailVerified)
      );
      const activePlayers = players.filter(player => 
        !player.isBanned && (!player.user || player.user.isEmailVerified)
      );

      // Set rank to -1 for banned players
      if (bannedPlayers.length > 0) {
        const bannedIds = bannedPlayers.map(p => p.id);
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
            { transaction }
          );
        } catch (error) {
          console.error('Error updating banned player ranks:', error);
          // Don't throw here, continue with the rest of the function
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
        
        // Sort players by score in descending order
        const sortedPlayers = activePlayers
          .filter(player => player.stats && player.stats[scoreType as keyof PlayerStats] > 0)
          .sort((a, b) => {
            const scoreA = a.stats?.[scoreType as keyof PlayerStats] || 0;
            const scoreB = b.stats?.[scoreType as keyof PlayerStats] || 0;
            return scoreB - scoreA;
          });

        // Update ranks in batches
        const batchSize = 1000;
        for (let i = 0; i < sortedPlayers.length; i += batchSize) {
          const batch = sortedPlayers.slice(i, i + batchSize);
          const updates = batch.map((player, index) => {
            const rank = i + index + 1;
            return `WHEN id = ${player.id} THEN ${rank}`;
          }).join(' ');

          if (updates) {
            try {
              await sequelize.query(
                `
                UPDATE player_stats
                SET ${rankField} = CASE ${updates} ELSE ${rankField} END
                WHERE id IN (${batch.map(p => p.id).join(',')})
                `,
                { transaction }
              );
            } catch (error) {
              console.error(`Error updating ${rankField} for batch:`, error);
              // Don't throw here, continue with the next batch
            }
          }
        }
      }
    } catch (error) {
      console.error('Error updating ranks:', error);
      // Don't throw here, let the caller handle the transaction
    }
  }

  public async forceUpdateRanks(): Promise<void> {
    const transaction = await sequelize.transaction();
    try {
      await this.updateRanks(transaction);
      try {
        await transaction.commit();
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
              AND levels.isHidden = false
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
            'AND levels.isDeleted = false ' +
            'AND levels.isHidden = false)'
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
            isDeleted: false,
            isHidden: false
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
            isDeleted: false,
            isHidden: false
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
