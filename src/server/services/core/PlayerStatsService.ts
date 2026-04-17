import PlayerStats from '@/models/players/PlayerStats.js';
import Player from '@/models/players/Player.js';
import Pass from '@/models/passes/Pass.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import sequelize from '@/config/db.js';
import {sseManager} from '@/misc/utils/server/sse.js';
import User from '@/models/auth/User.js';
import Judgement from '@/models/passes/Judgement.js';
import { escapeForMySQL } from '@/misc/utils/data/searchHelpers.js';
import { Op, QueryTypes } from 'sequelize';
import { ModifierService } from '../accounts/ModifierService.js';
import { logger } from './LoggerService.js';
import { IPlayer } from '@/server/interfaces/models/index.js';
import { OAuthProvider } from '@/models/index.js';
import Creator from '@/models/credits/Creator.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Team from '@/models/credits/Team.js';
import { roleSyncService } from '../accounts/RoleSyncService.js';
import dotenv from 'dotenv';
import { playerStatsQuery } from '@/server/services/elasticsearch/misc/playerStatsQuery.js';

dotenv.config();

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
  private modifierService: ModifierService | null = null;
  // Still used by a handful of pass-impact analytics reads below (currentStats/previousStats).
  private statsQuery = playerStatsQuery;


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

  /**
   * @deprecated Player statistics are now served by Elasticsearch.
   * This service no longer writes to the `player_stats` table or schedules any cron.
   * Reads (getPlayerStats / getLeaderboard / getEnrichedPlayer) remain for backward
   * compatibility but return data from whatever snapshot already exists in MySQL.
   */
  public async initialize() {
    if (this.isInitialized) return;
    this.isInitialized = true;
    logger.info('[PlayerStatsService] initialize() is a no-op — player stats are served by Elasticsearch.');
  }

  public static getInstance(): PlayerStatsService {
    if (!PlayerStatsService.instance) {
      PlayerStatsService.instance = new PlayerStatsService();
    }
    return PlayerStatsService.instance;
  }


  /**
   * @deprecated Use `ElasticsearchService.getInstance().reindexAllPlayers()` instead.
   * Kept as a no-op shim so any straggler caller does not crash during rollout.
   */
  public async reloadAllStats(): Promise<void> {
    logger.warn('[PlayerStatsService] reloadAllStats() is deprecated — use elasticsearchService.reindexAllPlayers().');
  }

  /**
   * @deprecated Use `ElasticsearchService.getInstance().reindexPlayers(ids)` instead.
   * No-op.
   */
  public async updatePlayerStats(
    _playerIds: number[],
  ): Promise<void> {
    logger.warn('[PlayerStatsService] updatePlayerStats() is deprecated — use elasticsearchService.reindexPlayers().');
  }

  /**
   * @deprecated Ranks are now computed on-demand by `getPlayerRanks()` in
   * `elasticsearch/search/playerSearch.ts`.
   */
  public async updateRanks(): Promise<void> {
    logger.warn('[PlayerStatsService] updateRanks() is deprecated — ranks are computed on-demand via ES count queries.');
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
