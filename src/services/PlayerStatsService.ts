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
import { Op } from 'sequelize';
import PlayerModifier, { ModifierType } from '../models/PlayerModifier.js';
import { ModifierService } from '../services/ModifierService.js';

export class PlayerStatsService {
  private static instance: PlayerStatsService;
  private isInitialized = false;
  private updateTimeout: NodeJS.Timeout | null = null;
  private readonly UPDATE_DELAY = 2 * 60 * 1000; // 2 minutes in milliseconds
  private readonly RELOAD_INTERVAL = 60 * 1000; // 1 minute in milliseconds
  private pendingPlayerIds: Set<number> = new Set();
  private modifierService: ModifierService;

  private constructor() {
    this.modifierService = ModifierService.getInstance();
  }

  public setModifiersEnabled(enabled: boolean): void {
    this.modifierService.setModifiersEnabled(enabled);
  }

  public isModifiersEnabled(): boolean {
    return this.modifierService.isModifiersEnabled();
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
            await this.updatePlayerStats(id, transaction);
          }

          // Update ranks for all players once
          await this.updateRanks(transaction);

          await transaction.commit();

          sseManager.broadcast({
            type: 'statsUpdate',
            data: {
              playerIds,
              action: 'batchUpdate',
            },
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
            ],
          },
        ],
        transaction,
      });

      // Prepare bulk update data
      const bulkStats = await Promise.all(players.map(async (player: any) => {
        // Calculate top difficulties
        const {topDiff, top12kDiff} = this.calculateTopDiffs(
          player.passes || [],
        );

        // Create base stats object
        const baseStats = {
          playerId: player.id,
          rankedScore: calculateRankedScore(player.passes || []),
          generalScore: calculateGeneralScore(player.passes || []),
          ppScore: calculatePPScore(player.passes || []),
          wfScore: calculateWFScore(player.passes || []),
          score12K: calculate12KScore(player.passes || []),
          averageXacc: calculateAverageXacc(player.passes || []),
          universalPassCount: countUniversalPassCount(player.passes || []),
          worldsFirstCount: countWorldsFirstPasses(player.passes || []),
          topDiff,
          top12kDiff,
          lastUpdated: new Date(),
        };

        // Apply modifiers if enabled
        return this.modifierService.applyScoreModifiers(player.id, baseStats);
      }));

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

        // Step 1: Set all banned players' ranks to -1
        await sequelize.query(
          `
          UPDATE player_stats ps
          JOIN players p ON ps.playerId = p.id
          SET ps.${rankField} = -1
          WHERE p.isBanned = true
          `,
          {transaction},
        );

        // Step 2: Calculate ranks for non-banned players
        await sequelize.query(
          `
          WITH RankedPlayers AS (
            SELECT 
              ps.id,
              @rowNumber := @rowNumber + 1 AS player_rank
            FROM (
              SELECT ps2.*
              FROM player_stats ps2
              JOIN players p2 ON ps2.playerId = p2.id
              WHERE p2.isBanned = false
              ORDER BY ps2.${scoreType} DESC, ps2.id ASC
            ) ps,
            (SELECT @rowNumber := 0) r
          )
          UPDATE player_stats ps
          JOIN players p ON ps.playerId = p.id
          JOIN RankedPlayers rp ON ps.id = rp.id
          SET ps.${rankField} = rp.player_rank
          WHERE p.isBanned = false
          `,
          {transaction},
        );
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

  public calculateTopDiffs(passes: Pass[] | IPass[]): {
    topDiff: number;
    top12kDiff: number;
  } {
    // Filter out deleted passes and those with difficulty ID >= 100
    const validPasses = (passes as any).filter(
      (pass: any) =>
        !pass.isDeleted &&
        pass.level?.difficulty?.id !== undefined &&
        pass.level.difficulty.type === 'PGU',
    );

    if (validPasses.length === 0) {
      return {topDiff: 0, top12kDiff: 0};
    }

    // Sort passes by difficulty sortOrder in descending order
    const sortedPasses = validPasses.sort((a: any, b: any) => {
      const diffA = a.level?.difficulty?.sortOrder || 0;
      const diffB = b.level?.difficulty?.sortOrder || 0;
      // If sortOrders are equal, compare level IDs in descending order
      if (diffB === diffA) {
        return (b.level?.id || 0) - (a.level?.id || 0);
      }
      return diffB - diffA;
    });

    // Get highest difficulty ID for regular passes
    const topDiff = sortedPasses[0]?.level?.difficulty?.id ?? 0;

    // Get highest difficulty ID for 12k passes
    const valid12kPasses = validPasses.filter(
      (pass: any) => pass.is12K && !pass.is16K,
    );

    const top12kDiff =
      valid12kPasses.length > 0
        ? (valid12kPasses.sort((a: any, b: any) => {
            const diffA = a.level?.difficulty?.sortOrder || 0;
            const diffB = b.level?.difficulty?.sortOrder || 0;
            // If sortOrders are equal, compare level IDs in descending order
            if (diffB === diffA) {
              return (b.level?.id || 0) - (a.level?.id || 0);
            }
            return diffB - diffA;
          })[0]?.level?.difficulty?.id ?? 0)
        : 0;

    return {topDiff, top12kDiff};
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
            ],
          },
        ],
        transaction,
      });

      if (!player || !player.passes) {
        throw new Error('Player or passes not found');
      }

      // Convert passes to scores and get highest score per level

      // Calculate top difficulties
      const {topDiff, top12kDiff} = this.calculateTopDiffs(player.passes);

      // Calculate all scores using the filtered scores
      const stats = {
        playerId,
        rankedScore: calculateRankedScore(player.passes),
        generalScore: calculateGeneralScore(player.passes),
        ppScore: calculatePPScore(player.passes),
        wfScore: calculateWFScore(player.passes),
        score12K: calculate12KScore(player.passes),
        averageXacc: calculateAverageXacc(player.passes),
        universalPassCount: countUniversalPassCount(player.passes),
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

  private async reloadAllStatsCron() {
    console.log('Setting up cron for full stats reload');
    setInterval(async () => {
      await this.reloadAllStats();
    }, this.RELOAD_INTERVAL);
  }

  public async updateRanks(transaction?: any): Promise<void> {
    const scoreTypes = [
      'rankedScore',
      'generalScore',
      'ppScore',
      'wfScore',
      'score12K',
    ];

    for (const scoreType of scoreTypes) {
      const rankField = `${scoreType}Rank`;

      // Step 1: Set all banned players' ranks to -1
      await sequelize.query(
        `
        UPDATE player_stats ps
        JOIN players p ON ps.playerId = p.id
        SET ps.${rankField} = -1
        WHERE p.isBanned = true
        `,
        {transaction},
      );

      // Step 2: Calculate ranks for non-banned players
      await sequelize.query(
        `
        WITH RankedPlayers AS (
          SELECT 
            ps.id,
            @rowNumber := @rowNumber + 1 AS player_rank
          FROM (
            SELECT ps2.*
            FROM player_stats ps2
            JOIN players p2 ON ps2.playerId = p2.id
            WHERE p2.isBanned = false
            ORDER BY ps2.${scoreType} DESC, ps2.id ASC
          ) ps,
          (SELECT @rowNumber := 0) r
        )
        UPDATE player_stats ps
        JOIN players p ON ps.playerId = p.id
        JOIN RankedPlayers rp ON ps.id = rp.id
        SET ps.${rankField} = rp.player_rank
        WHERE p.isBanned = false
        `,
        {transaction},
      );
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
              WHERE passes.playerId = PlayerStats.playerId
              AND passes.isDeleted = false 
              AND passes.isHidden = false
              AND levels.isDeleted = false 
              AND levels.isHidden = false
            )`),
            'totalPasses',
          ],
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
            'AND passes.isHidden = false ' +
            'AND levels.isDeleted = false ' +
            'AND levels.isHidden = false)'
          ),
          rankField: null,
        },
        universalPassCount: {field: 'universalPassCount', rankField: null},
        worldsFirstCount: {field: 'worldsFirstCount', rankField: null},
        topDiff: {
          field: sequelize.literal(
            '(SELECT difficulties.sortOrder FROM difficulties ' +
            'INNER JOIN levels ON levels.diffId = difficulties.id ' +
            'INNER JOIN passes ON passes.levelId = levels.id ' +
            'WHERE passes.playerId = player.id ' +
            'AND passes.isDeleted = false ' +
            'AND passes.isHidden = false ' +
            'AND difficulties.id < 100 ' +
            'AND levels.isDeleted = false ' +
            'AND levels.isHidden = false ' +
            'ORDER BY difficulties.sortOrder DESC LIMIT 1)',
          ),
          rankField: null,
        },
        top12kDiff: {
          field: sequelize.literal(
            '(SELECT difficulties.sortOrder FROM difficulties ' +
            'INNER JOIN levels ON levels.diffId = difficulties.id ' +
            'INNER JOIN passes ON passes.levelId = levels.id ' +
            'WHERE passes.playerId = player.id ' +
            'AND passes.isDeleted = false ' +
            'AND passes.isHidden = false ' +
            'AND passes.is12K = true ' +
            'AND difficulties.id < 100 ' +
            'AND levels.isDeleted = false ' +
            'AND levels.isHidden = false ' +
            'ORDER BY difficulties.sortOrder DESC LIMIT 1)',
          ),
          rankField: null,
        },
      };

      const sortInfo = sortFieldMap[sortBy] || sortFieldMap['rankedScore'];
      const orderField = sortInfo.field;
      const orderItem: [any, string] = [orderField, order.toUpperCase()];

      // Get total count first
      const total = await PlayerStats.count({
        include: [{
          model: Player,
          as: 'player',
          required: true
        }],
        where: whereClause
      });

      // Then get paginated results
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
        order: [orderItem, ['id', 'DESC']],
        offset,
        limit
      });

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
    });

    if (!pass) {
      return null;
    }

    // Get player's passes for score calculation
    const playerPasses = await Pass.findAll({
      where: {
        playerId: pass.player?.id,
        isDeleted: false,
        isHidden: false
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
