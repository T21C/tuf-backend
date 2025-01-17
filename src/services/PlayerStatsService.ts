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
import cliProgress from 'cli-progress';
import colors from 'ansi-colors';

// Define progress bar format
const progressBar = new cliProgress.MultiBar({
  format: colors.cyan('{bar}') + ' | {percentage}% | {task} | {subtask}',
  barCompleteChar: '\u2588',
  barIncompleteChar: '\u2591',
  hideCursor: true,
  clearOnComplete: true,
  noTTYOutput: !process.stdout.isTTY,
  stream: process.stdout,
  fps: 10,
  forceRedraw: true,
}, cliProgress.Presets.shades_classic);

export class PlayerStatsService {
  private static instance: PlayerStatsService;
  private isInitialized: boolean = false;

  private constructor() {}

  public async initialize() {
    if (this.isInitialized) return;
    
    const initBar = progressBar.create(100, 0, {
      task: 'Player Stats Service',
      subtask: 'Initializing...'
    });
    
    try {
      initBar.update(50, { subtask: 'Reloading all stats' });
      await this.reloadAllStats();
      this.isInitialized = true;
      initBar.update(100, { subtask: 'Complete' });
    } catch (error) {
      initBar.update(100, { subtask: 'Failed' });
      throw error;
    } finally {
      initBar.stop();
      progressBar.remove(initBar);
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
    const reloadBar = progressBar.create(100, 0, {
      task: 'Stats Reload',
      subtask: 'Starting...'
    });

    try {
      transaction = await sequelize.transaction();
      
      // First, get all player IDs
      reloadBar.update(5, { subtask: 'Loading player IDs' });
      const playerIds = await Player.findAll({
        attributes: ['id'],
        transaction,
      }).then(players => players.map(p => p.id));

      reloadBar.update(10, { subtask: `Processing ${playerIds.length} players` });
      
      // Process players in batches
      const BATCH_SIZE = 50;
      const bulkStats = [];
      
      for (let i = 0; i < playerIds.length; i += BATCH_SIZE) {
        const batchIds = playerIds.slice(i, i + BATCH_SIZE);
        const progress = Math.floor(10 + (i / playerIds.length) * 50);
        reloadBar.update(progress, { subtask: `Loading batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(playerIds.length/BATCH_SIZE)}` });
        
        // Load batch of players with their data
        const players = await Player.findAll({
          where: { id: batchIds },
          include: [
            {
              model: Pass,
              as: 'passes',
              where: { isDeleted: false },
              required: false,
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

        // Process each player in the batch
        for (const player of players) {
          const scores = this.convertPassesToScores(player.passes || []);
          const uniqueScores = this.getHighestScorePerLevel(scores);
          
          bulkStats.push({
            playerId: player.id,
            rankedScore: calculateRankedScore(uniqueScores),
            generalScore: calculateGeneralScore(uniqueScores),
            ppScore: calculatePPScore(uniqueScores),
            wfScore: calculateWFScore(uniqueScores),
            score12k: calculate12KScore(uniqueScores),
            averageXacc: calculateAverageXacc(uniqueScores),
            universalPassCount: countUniversalPasses(player.passes || []),
            worldsFirstCount: countWorldsFirstPasses(player.passes || []),
            lastUpdated: new Date(),
          });
        }
      }

      reloadBar.update(70, { subtask: 'Updating database' });
      await PlayerStats.bulkCreate(bulkStats, {
        updateOnDuplicate: [
          'rankedScore',
          'generalScore',
          'ppScore',
          'wfScore',
          'score12k',
          'averageXacc',
          'universalPassCount',
          'worldsFirstCount',
          'lastUpdated',
        ],
        transaction,
      });

      reloadBar.update(80, { subtask: 'Updating ranks' });
      const scoreTypes = [
        'rankedScore',
        'generalScore',
        'ppScore',
        'wfScore',
        'score12k',
      ];

      // Update ranks using direct SQL for better performance
      for (const [index, scoreType] of scoreTypes.entries()) {
        const progress = Math.floor(80 + (index / scoreTypes.length) * 15);
        reloadBar.update(progress, { subtask: `Updating ${scoreType} ranks` });
        
        const rankField = `${scoreType}Rank`;
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

      reloadBar.update(95, { subtask: 'Committing changes' });
      await transaction.commit();

      reloadBar.update(100, { subtask: 'Notifying clients' });
      const io = getIO();
      io.emit('leaderboardUpdated');
      
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
    } finally {
      reloadBar.stop();
      progressBar.remove(reloadBar);
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
        xacc: pass.accuracy || 0,
        isWorldsFirst: pass.isWorldsFirst || false,
        is12K: pass.is12K || false,
        isDeleted: pass.isDeleted || false,
        levelId: pass.level?.id || 0,
      }));
  }

  public async updatePlayerStats(playerId: number, existingTransaction?: any): Promise<void> {
    const transaction = existingTransaction || await sequelize.transaction();
    const shouldCommit = !existingTransaction;
    const updateBar = progressBar.create(100, 0, {
      task: 'Player Stats Update',
      subtask: 'Starting...'
    });

    try {
      updateBar.update(10, { subtask: 'Loading player data' });
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

      updateBar.update(30, { subtask: 'Processing scores' });
      const scores = this.convertPassesToScores(player.passes);
      const uniqueScores = this.getHighestScorePerLevel(scores);

      updateBar.update(50, { subtask: 'Calculating stats' });
      const stats = {
        playerId,
        rankedScore: calculateRankedScore(uniqueScores),
        generalScore: calculateGeneralScore(uniqueScores),
        ppScore: calculatePPScore(uniqueScores),
        wfScore: calculateWFScore(uniqueScores),
        score12k: calculate12KScore(uniqueScores),
        averageXacc: calculateAverageXacc(uniqueScores),
        universalPassCount: countUniversalPasses(player.passes),
        worldsFirstCount: countWorldsFirstPasses(player.passes),
        lastUpdated: new Date(),
      };

      updateBar.update(70, { subtask: 'Updating database' });
      await PlayerStats.upsert(stats, {transaction});

      updateBar.update(80, { subtask: 'Updating ranks' });
      await this.updateRanks(transaction);

      if (shouldCommit) {
        updateBar.update(90, { subtask: 'Committing changes' });
        await transaction.commit();

        updateBar.update(100, { subtask: 'Notifying clients' });
        const io = getIO();
        io.emit('leaderboardUpdated');
        
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
    } finally {
      updateBar.stop();
      progressBar.remove(updateBar);
    }
  }

  private async updateRanks(transaction: any): Promise<void> {
    const scoreTypes = [
      'rankedScore',
      'generalScore',
      'ppScore',
      'wfScore',
      'score12k',
    ];

    // Update ranks using direct SQL for better performance
    for (const scoreType of scoreTypes) {
      const rankField = `${scoreType}Rank`;
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
  }

  public async getPlayerStats(playerId: number): Promise<PlayerStats | null> {
    const playerStats = await PlayerStats.findOne({
      attributes: {
        include: [
          [
            sequelize.literal(`(
              SELECT difficulties.sortOrder 
              FROM passes 
              JOIN levels ON levels.id = passes.levelId 
              JOIN difficulties ON difficulties.id = levels.diffId 
              WHERE passes.playerId = PlayerStats.playerId 
              AND passes.isDeleted = false 
              ORDER BY difficulties.sortOrder DESC 
              LIMIT 1
            )`),
            'topDiff'
          ],
          [
            sequelize.literal(`(
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
            'top12kDiff'
          ],
          [
            sequelize.literal(`(
              SELECT COUNT(*) 
              FROM passes 
              WHERE passes.playerId = PlayerStats.playerId 
              AND passes.isDeleted = false
            )`),
            'totalPasses'
          ],
        ],
      },
      where: { playerId },
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
      'score12k': 'score12k',
      'averageXacc': 'averageXacc',
      'totalPasses': sequelize.literal('(SELECT COUNT(*) FROM passes WHERE passes.playerId = player_stats.playerId AND passes.isDeleted = false)'),
      'universalPasses': 'universalPassCount',
      'worldsFirstCount': 'worldsFirstCount',
      'topDiff': sequelize.literal(`(
        SELECT difficulties.sortOrder 
        FROM passes 
        JOIN levels ON levels.id = passes.levelId 
        JOIN difficulties ON difficulties.id = levels.diffId 
        WHERE passes.playerId = player_stats.playerId 
        AND passes.isDeleted = false 
        ORDER BY difficulties.sortOrder DESC 
        LIMIT 1
      )`),
      'top12kDiff': sequelize.literal(`(
        SELECT difficulties.sortOrder 
        FROM passes 
        JOIN levels ON levels.id = passes.levelId 
        JOIN difficulties ON difficulties.id = levels.diffId 
        WHERE passes.playerId = player_stats.playerId 
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