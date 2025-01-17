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

export class PlayerStatsService {
  private static instance: PlayerStatsService;
  private isInitialized: boolean = false;

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

  public async reloadAllStats(): Promise<void> {
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

      console.log(`Found ${players.length} players to process`);

      // Prepare bulk update data
      const bulkStats = players.map(player => {

        // Convert passes to scores and get highest score per level
        const scores = this.convertPassesToScores(player.passes || []);
        const uniqueScores = this.getHighestScorePerLevel(scores);
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
      console.log('Successfully reloaded all player stats');

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

  private getHighestScorePerLevel(scores: Score[], doLog: boolean = false): Score[] {
    const levelScores = new Map<number, Score>();
    scores.forEach(score => {
      const levelId = score.levelId;
      if (!levelId) return;
      
      const existingScore = levelScores.get(levelId);
      if (!existingScore || score.score > existingScore.score) {
        if (existingScore && doLog) {
          console.log(`Replacing score for level ${levelId}: ${existingScore.score} with higher score: ${score.score}`);
        }
        levelScores.set(levelId, score);
      } else {
        if (doLog) {
          console.log(`Ignoring lower score for level ${levelId}: ${score.score} (keeping ${existingScore.score})`);
        }
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
        xacc: pass.accuracy || 0,
        speed: pass.speed || 0,
        isWorldsFirst: pass.isWorldsFirst || false,
        is12K: pass.is12K || false,
        isDeleted: pass.isDeleted || false,
        levelId: pass.level?.id || 0,
      }));
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
        lastUpdated: new Date(),
      };

      console.log('Calculated stats:', JSON.stringify(stats, null, 2));

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
  ): Promise<PlayerStats[]> {
    const whereClause: any = {};
    if (showBanned !== 'show') {
      whereClause['$player.isBanned$'] = showBanned === 'only';
    }

    // Map frontend sort fields to database fields
    const sortFieldMap: { [key: string]: any } = {
      'rankedScore': 'rankedScore',
      'generalScore': 'generalScore',
      'ppScore': 'ppScore',
      'wfScore': 'wfScore',
      'score12K': 'score12K',
      'averageXacc': 'averageXacc',
      'totalPasses': sequelize.literal('(SELECT COUNT(*) FROM passes WHERE passes.playerId = PlayerStats.playerId AND passes.isDeleted = false)'),
      'universalPasses': 'universalPassCount',
      'worldsFirstCount': 'worldsFirstCount',
      'topDiff': sequelize.literal(`(
        SELECT difficulties.sortOrder 
        FROM passes 
        JOIN levels ON levels.id = passes.levelId 
        JOIN difficulties ON difficulties.id = levels.diffId 
        WHERE passes.playerId = PlayerStats.playerId 
        AND passes.isDeleted = false 
        ORDER BY difficulties.sortOrder DESC 
        LIMIT 1
      )`),
      'top12kDiff': sequelize.literal(`(
        SELECT difficulties.sortOrder 
        FROM passes 
        JOIN levels ON levels.id = passes.levelId 
        JOIN difficulties ON difficulties.id = levels.diffId 
        WHERE passes.playerId = PlayerStats.playerId 
        AND passes.isDeleted = false 
        AND passes.is12K = true 
        ORDER BY difficulties.sortOrder DESC 
        LIMIT 1
      )`),
    };

    // First get all players ordered by rankedScore for rank calculation
    const rankedPlayers = await PlayerStats.findAll({
      attributes: {
        include: [
          [sortFieldMap['totalPasses'], 'totalPasses'],
          [sortFieldMap['topDiff'], 'topDiff'],
          [sortFieldMap['top12kDiff'], 'top12kDiff'],
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
              attributes: ['avatarUrl'],
              required: false,
            },
          ],
        },
      ],
      where: whereClause,
      order: [['rankedScore', 'DESC']],
    });

    // Create a map of player ID to rank
    const rankMap = new Map(rankedPlayers.map((playerStat, index) => {
      const player = playerStat.get({ plain: true });
      return [player.player.id, index + 1];
    }));

    // Get the actual leaderboard with the requested sorting
    const orderField = sortFieldMap[sortBy] || 'rankedScore';
    const orderItem: [any, string] = [
      typeof orderField === 'string' ? orderField : sequelize.literal(orderField),
      order.toUpperCase()
    ];

    const leaderboard = await PlayerStats.findAll({
      attributes: {
        include: [
          [sortFieldMap['totalPasses'], 'totalPasses'],
          [sortFieldMap['topDiff'], 'topDiff'],
          [sortFieldMap['top12kDiff'], 'top12kDiff'],
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
              attributes: ['avatarUrl'],
              required: false,
            },
          ],
        },
      ],
      where: whereClause,
      order: [orderItem],
    });

    // Add rank and rename fields to match frontend expectations
    return leaderboard.map(player => {
      const plainPlayer = player.get({ plain: true });
      return {
        ...plainPlayer,
        id: plainPlayer.player.id,
        rank: rankMap.get(plainPlayer.player.id),
        player: {
          ...plainPlayer.player,
          pfp: plainPlayer.player.user?.avatarUrl || plainPlayer.player.pfp || null,
        },
      };
    });
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
          attributes: ['id', 'name', 'country', 'isBanned', 'pfp'],
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
          attributes: ['id', 'song', 'artist', 'team', 'charter', 'vfxer', 'baseScore'],
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

    // Calculate current and previous ranked scores
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
 