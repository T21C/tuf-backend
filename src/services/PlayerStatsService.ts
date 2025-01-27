import {Op} from 'sequelize';
import PlayerStats from '../models/PlayerStats';
import Player from '../models/Player';
import Pass from '../models/Pass';
import Level from '../models/Level';
import Difficulty from '../models/Difficulty';
import {IPass} from '../interfaces/models';
import {
  calculateRankedScore,
  calculateGeneralScore,
  calculatePPScore,
  calculateWFScore,
  calculate12KScore,
  calculateAverageXacc,
  countUniversalPasses,
  countWorldsFirstPasses,
} from '../misc/PlayerStatsCalculator';
import {Score} from '../misc/PlayerStatsCalculator';
import sequelize from '../config/db';
import {getIO} from '../utils/socket';
import {sseManager} from '../utils/sse';
import User from '../models/User';
import Judgement from '../models/Judgement';
import { calcAcc } from '../misc/CalcAcc';
import { getScoreV2 } from '../misc/CalcScore';

export class PlayerStatsService {
  private static instance: PlayerStatsService;
  private isInitialized: boolean = false;
  private updateTimeout: NodeJS.Timeout | null = null;
  private readonly UPDATE_DELAY = 2 * 60 * 1000; // 2 minutes in milliseconds
  private pendingPlayerIds: Set<number> = new Set();

  private constructor() {
    // Remove automatic initialization
  }

  public async initialize() {
    if (this.isInitialized) return;
    
    try {
      console.log('Initializing PlayerStatsService...');
      await this.reloadAllStats();
      this.isInitialized = true;
      console.log('PlayerStatsService initialized successfully');
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
            await this.updatePlayerStats(id, transaction);
          }
          
          // Update ranks for all players once
          await this.updateRanks(transaction);
          
          await transaction.commit();

          // Notify clients about the update
          const io = getIO();
          io.emit('leaderboardUpdated');
          
          // Emit SSE event
          sseManager.broadcast({
            type: 'statsUpdate',
            data: {
              playerIds,
              action: 'batchUpdate'
            }
          });
        } catch (error) {
          await transaction.rollback();
          throw error;
        }
      } catch (error) {
        console.error('Error in scheduled stats update:', error);
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
      transaction = await sequelize.transaction();
      
      console.log('Starting full stats reload...');

      // Get all players with their passes in a single query
      const players = await Player.findAll({
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
        transaction,
      });

      // Prepare bulk update data
      const bulkStats = players.map(player => {
        // Convert passes to scores and get highest score per level
        const scores = this.convertPassesToScores(player.passes || []);
        const uniqueScores = this.getHighestScorePerLevel(scores);
        
        // Calculate top difficulties
        const { topDiff, top12kDiff } = this.calculateTopDiffs(player.passes || []);

        return {
          playerId: player.id,
          rankedScore: calculateRankedScore(uniqueScores),
          generalScore: calculateGeneralScore(uniqueScores),
          ppScore: calculatePPScore(uniqueScores),
          wfScore: calculateWFScore(uniqueScores),
          score12K: calculate12KScore(uniqueScores),
          averageXacc: calculateAverageXacc(uniqueScores),
          universalPassCount: countUniversalPasses(player.passes || []),
          worldsFirstCount: countWorldsFirstPasses(player.passes || []),
          topDiff,
          top12kDiff,
          lastUpdated: new Date(),
        };
      });

      // Bulk upsert all stats
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
          'topDiff',
          'top12kDiff',
          'lastUpdated',
        ],
        transaction,
      });

      // Update ranks in bulk for each score type
      const scoreTypes = [
        'rankedScore',
        'generalScore',
        'ppScore',
        'wfScore',
        'score12K',
      ];

      for (const scoreType of scoreTypes) {
        const rankField = `${scoreType}Rank`;
        
        // MySQL-compatible rank update query
        await sequelize.query(`
          UPDATE player_stats ps
          JOIN (
            SELECT id, 
                   @rank := @rank + 1 as new_rank
            FROM player_stats, (SELECT @rank := 0) r
            ORDER BY ${scoreType} DESC
          ) ranked ON ps.id = ranked.id
          SET ps.${rankField} = ranked.new_rank
        `, { transaction });
      }

      await transaction.commit();

      // Notify clients about the update
      const io = getIO();
      io.emit('leaderboardUpdated');
      
      // Emit SSE event
      sseManager.broadcast({
        type: 'statsUpdate',
        data: {
          action: 'fullReload',
        },
      });
    } catch (error) {
      if (transaction) {
        await transaction.rollback();
      }
      throw error;
    }
  }

  private getHighestScorePerLevel(scores: Score[]): Score[] {
    const levelScores = new Map<number, Score>();
    scores.forEach(score => {
      const levelId = score.levelId;
      if (!levelId) return;
      
      const existingScore = levelScores.get(levelId);
      if (!existingScore || score.score > existingScore.score) {

        levelScores.set(levelId, score);
      }
    });
    return Array.from(levelScores.values());
  }

  private convertPassesToScores(passes: IPass[] | Pass[]): Score[] {
    return passes
      .filter(pass => !pass.isDeleted)
      .map(pass => ({
        score: pass.scoreV2 || 0,
        baseScore: pass.level?.baseScore || 0,
        xacc: pass.accuracy || 0.95,
        speed: pass.speed || 1,
        isWorldsFirst: pass.isWorldsFirst || false,
        is12K: pass.is12K || false,
        isDeleted: pass.isDeleted || false,
        levelId: pass.levelId
      }));
  }

  private calculateTopDiffs(passes: Pass[] | IPass[]): { topDiff: number, top12kDiff: number } {
    // Filter out deleted passes and those with difficulty ID >= 100
    const validPasses = passes.filter(pass => 
      !pass.isDeleted && 
      pass.level?.difficulty?.id !== undefined &&
      pass.level.difficulty.id < 100
    );

    if (validPasses.length === 0) {
      return { topDiff: 0, top12kDiff: 0 };
    }

    // Sort passes by difficulty sortOrder in descending order
    const sortedPasses = validPasses.sort((a, b) => {
      const diffA = a.level?.difficulty?.sortOrder || 0;
      const diffB = b.level?.difficulty?.sortOrder || 0;
      return diffB - diffA;
    });

    // Get highest difficulty ID for regular passes
    const topDiff = sortedPasses[0]?.level?.difficulty?.id ?? 0;

    // Get highest difficulty ID for 12k passes
    const valid12kPasses = validPasses.filter(pass => 
      pass.is12K && !pass.is16K
    );

    const top12kDiff = valid12kPasses.length > 0 
      ? valid12kPasses.sort((a, b) => {
          const diffA = a.level?.difficulty?.sortOrder || 0;
          const diffB = b.level?.difficulty?.sortOrder || 0;
          return diffB - diffA;
        })[0]?.level?.difficulty?.id ?? 0
      : 0;

    return { topDiff, top12kDiff };
  }

  public async updatePlayerStats(playerId: number, existingTransaction?: any): Promise<void> {
    const transaction = existingTransaction || await sequelize.transaction();
    const shouldCommit = !existingTransaction;

    try {
      const player = await Player.findByPk(playerId, {
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
        transaction,
      });

      if (!player || !player.passes) {
        throw new Error('Player or passes not found');
      }

      // Convert passes to scores and get highest score per level
      const scores = this.convertPassesToScores(player.passes);
      const uniqueScores = this.getHighestScorePerLevel(scores);

      // Calculate top difficulties
      const { topDiff, top12kDiff } = this.calculateTopDiffs(player.passes);

      // Calculate all scores using the filtered scores
      const stats = {
        playerId,
        rankedScore: calculateRankedScore(uniqueScores),
        generalScore: calculateGeneralScore(uniqueScores),
        ppScore: calculatePPScore(uniqueScores),
        wfScore: calculateWFScore(uniqueScores),
        score12K: calculate12KScore(uniqueScores),
        averageXacc: calculateAverageXacc(uniqueScores),
        universalPassCount: countUniversalPasses(player.passes),
        worldsFirstCount: countWorldsFirstPasses(player.passes),
        topDiff,
        top12kDiff,
        lastUpdated: new Date(),
      };

      // Update or create player stats
      await PlayerStats.upsert(stats, {transaction});

      // Update ranks for all players
      await this.updateRanks(transaction);

      if (shouldCommit) {
        await transaction.commit();

        // Notify clients about the update
        const io = getIO();
        io.emit('leaderboardUpdated');
        
        // Emit SSE event
        sseManager.broadcast({
          type: 'statsUpdate',
          data: {
            playerId,
            newStats: stats,
          },
        });
      }
    } catch (error) {
      if (shouldCommit) {
        await transaction.rollback();
      }
      throw error;
    }
  }

  private async updateRanks(transaction: any): Promise<void> {
    const scoreTypes = [
      'rankedScore',
      'generalScore',
      'ppScore',
      'wfScore',
      'score12K',
    ];

    for (const scoreType of scoreTypes) {
      const rankField = `${scoreType}Rank`;
      
      // Get all players ordered by score
      const players = await PlayerStats.findAll({
        order: [[scoreType, 'DESC']],
        transaction,
      });

      // Update ranks
      for (let i = 0; i < players.length; i++) {
        const player = players[i];
        await player.update(
          {[rankField]: i + 1},
          {transaction},
        );
      }
    }
  }

  public async getPlayerStats(playerId: number): Promise<PlayerStats | null> {
    const playerStats = await PlayerStats.findOne({
      attributes: {
        include: [
          [sequelize.literal('(SELECT COUNT(*) FROM passes WHERE passes.playerId = PlayerStats.playerId AND passes.isDeleted = false)'), 'totalPasses'],
          [sequelize.literal(`(
            SELECT difficulties.sortOrder 
            FROM passes 
            JOIN levels ON levels.id = passes.levelId 
            JOIN difficulties ON difficulties.id = levels.diffId 
            WHERE passes.playerId = PlayerStats.playerId 
            AND passes.isDeleted = false 
            ORDER BY difficulties.sortOrder DESC 
            LIMIT 1
          )`), 'topDiff'],
          [sequelize.literal(`(
            SELECT difficulties.sortOrder 
            FROM passes 
            JOIN levels ON levels.id = passes.levelId 
            JOIN difficulties ON difficulties.id = levels.diffId 
            WHERE passes.playerId = PlayerStats.playerId 
            AND passes.isDeleted = false 
            AND passes.is12K = true 
            ORDER BY difficulties.sortOrder DESC 
            LIMIT 1
          )`), 'top12kDiff'],
        ],
      },
      where: {playerId},
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
      ],
    });

    if (!playerStats) return null;

    const plainStats = playerStats.get({ plain: true });
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
    sortBy: string = 'rankedScore',
    order: 'asc' | 'desc' = 'desc',
    showBanned: 'show' | 'hide' | 'only' = 'show',
    playerId?: number
  ): Promise<PlayerStats[]> {
    try {
      const whereClause: any = {};
      if (showBanned === 'hide') {
        whereClause['$player.isBanned$'] = false;
      } else if (showBanned === 'only') {
        whereClause['$player.isBanned$'] = true;
      }

      // Add player ID filter if provided
      if (playerId) {
        whereClause['$player.id$'] = playerId;
      }

      // Map frontend sort fields to database fields and their corresponding rank fields
      const sortFieldMap: { [key: string]: { field: any, rankField: string | null } } = {
        'rankedScore': { field: 'rankedScore', rankField: 'rankedScoreRank' },
        'generalScore': { field: 'generalScore', rankField: 'generalScoreRank' },
        'ppScore': { field: 'ppScore', rankField: 'ppScoreRank' },
        'wfScore': { field: 'wfScore', rankField: 'wfScoreRank' },
        'score12K': { field: 'score12K', rankField: 'score12KRank' },
        'averageXacc': { field: 'averageXacc', rankField: null },
        'totalPasses': { 
          field: sequelize.literal('(SELECT COUNT(*) FROM passes WHERE passes.playerId = player.id AND passes.isDeleted = false)'),
          rankField: null
        },
        'universalPasses': { field: 'universalPassCount', rankField: null },
        'worldsFirstCount': { field: 'worldsFirstCount', rankField: null },
        'topDiff': { 
          field: sequelize.literal('(SELECT difficulties.sortOrder FROM difficulties INNER JOIN levels ON levels.diffId = difficulties.id INNER JOIN passes ON passes.levelId = levels.id WHERE passes.playerId = player.id AND passes.isDeleted = false AND difficulties.id < 100 ORDER BY difficulties.sortOrder DESC LIMIT 1)'),
          rankField: null
        },
        'top12kDiff': { 
          field: sequelize.literal('(SELECT difficulties.sortOrder FROM difficulties INNER JOIN levels ON levels.diffId = difficulties.id INNER JOIN passes ON passes.levelId = levels.id WHERE passes.playerId = player.id AND passes.isDeleted = false AND passes.is12K = true AND difficulties.id < 100 ORDER BY difficulties.sortOrder DESC LIMIT 1)'),
          rankField: null
        }
      };

      const sortInfo = sortFieldMap[sortBy] || sortFieldMap['rankedScore'];
      const orderField = sortInfo.field;
      const orderItem: [any, string] = [
        orderField,
        order.toUpperCase()
      ];

      // Single efficient query with all needed data
      const players = await PlayerStats.findAll({
        attributes: {
          include: [
            [sortFieldMap['totalPasses'].field, 'totalPasses'],
            [sortFieldMap['topDiff'].field, 'topDiff'],
            [sortFieldMap['top12kDiff'].field, 'top12kDiff'],
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
                attributes: ['avatarUrl', 'username'],
                required: false,
              },
            ],
          },
        ],
        where: whereClause,
        order: [orderItem],
      });

      // Map the results using either stored ranks or calculated ranks
      return players.map(player => {
        const plainPlayer = player.get({ plain: true });
        return {
          ...plainPlayer,
          id: plainPlayer.player.id,
          // Always use rankedScoreRank for consistency
          rank: plainPlayer.rankedScoreRank,
          player: {
            ...plainPlayer.player,
            pfp: plainPlayer.player.user?.avatarUrl || plainPlayer.player.pfp || null,
          },
        };
      });
    } catch (error) {
      console.error('Error in getLeaderboard:', error);
      throw error;
    }
  }

  public async getPassDetails(passId: number): Promise<any> {
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
        isDeleted: false,
      },
      include: [
        {
          model: Level,
          as: 'level',
          attributes: ['baseScore'],
        },
      ],
    });

    // Convert passes to scores and get highest score per level
    const scores = this.convertPassesToScores(playerPasses);
    const uniqueScores = this.getHighestScorePerLevel(scores);

    // Calculate current and previou
    const currentRankedScore = calculateRankedScore(uniqueScores);
    const previousRankedScore = calculateRankedScore(
      this.getHighestScorePerLevel(
        this.convertPassesToScores(playerPasses.filter(p => p.id !== pass.id))
      )
    );

    // Get player stats for rank
    const playerStats = await this.getPlayerStats(pass.player?.id || 0);

    const response = {
      ...pass.toJSON(),
      player: {
        ...pass.player?.toJSON(),
        discordUsername: pass.player?.user?.username,
        discordAvatar: pass.player?.user?.avatarUrl,
        pfp: pass.player?.user?.avatarUrl || pass.player?.pfp || null,
      },
      scoreInfo: {
        currentRankedScore,
        previousRankedScore,
        scoreDifference: currentRankedScore - previousRankedScore,
      },
      ranks: {
        rankedScoreRank: playerStats?.rankedScoreRank,
      },
    };

    return response;
  }
} 
 