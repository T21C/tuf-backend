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
import ElasticsearchService from '@/server/services/elasticsearch/ElasticsearchService.js';
import { getRankedScoreRanksForHits } from '@/server/services/elasticsearch/search/players/playerSearch.js';

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
      verificationStatus: 'declined' | 'pending' | 'conditional' | 'allowed';
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
                    attributes: ['id', 'name', 'verificationStatus'],
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

    const playerId = pass.player?.id;
    /** Same global rank as v3 leaderboard (`getRankedScoreRanksForHits`), not MySQL `player_stats.rankedScoreRank`. */
    let rankedScoreRank: number | undefined;
    if (playerId) {
      try {
        const esDoc = await ElasticsearchService.getInstance().getPlayerDocumentById(playerId);
        if (esDoc) {
          const [r] = await getRankedScoreRanksForHits([
            { isBanned: esDoc.isBanned, rankedScore: esDoc.rankedScore },
          ]);
          rankedScoreRank = r;
        }
      } catch (error) {
        logger.warn('[PlayerStatsService] getPassDetails: ES rankedScoreRank failed', error);
      }
      if (rankedScoreRank === undefined) {
        const playerStats = await this.getPlayerStats(playerId).then((stats) => stats?.[0]);
        rankedScoreRank = playerStats?.rankedScoreRank;
      }
    }

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
        rankedScoreRank,
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
          attributes: ['id', 'name', 'verificationStatus'],
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
              verificationStatus: userData.creator.verificationStatus
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
  

  /**
   * Fetch a page of a player's passes.
   *
   * Split out from `getEnrichedPlayer` so profile responses stay small — the
   * full list can be thousands of rows with levels/credits/judgements joined
   * in. Sorting, filtering and searching are handled server-side so the
   * client can paginate via `InfiniteScroll` without needing the entire
   * dataset in memory.
   *
   * Hidden passes are only visible to the owning user, and only if they
   * opt in via `showHidden`.
   */
  public async getPlayerPasses(
    playerId: number,
    user: any | undefined,
    opts: {
      limit?: number;
      offset?: number;
      sortBy?: 'score' | 'speed' | 'date' | 'xacc' | 'difficulty' | 'impact';
      order?: 'ASC' | 'DESC';
      query?: string;
      showHidden?: boolean;
    } = {},
  ): Promise<{ total: number; passes: Pass[] }> {
    const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 50)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const order = opts.order === 'ASC' ? 'ASC' : 'DESC';
    const sortBy = opts.sortBy ?? 'score';

    const isOwnProfile = Boolean(user && user.playerId && user.playerId === playerId);
    const includeHiddenPasses = isOwnProfile && opts.showHidden === true;

    // --- Phase 1: resolve ordered pass ids + total count via raw SQL. ---
    //
    // Sequelize's `findAndCountAll` with many-to-many includes (levelCredits)
    // either over-counts rows or applies LIMIT after the join flattening,
    // producing fewer than `limit` unique passes per page. Running a tight,
    // hand-written SQL query for pagination sidesteps that entirely; we
    // follow up with a normal Sequelize query keyed on `id IN (...)` to
    // hydrate the full object tree.
    const dir = order;
    const inv = order === 'DESC' ? 'ASC' : 'DESC';
    const filterClauses: string[] = [
      'p.playerId = :playerId',
      'IFNULL(p.isDeleted, 0) = 0',
      'IFNULL(l.isDeleted, 0) = 0',
    ];
    if (!includeHiddenPasses) {
      filterClauses.push('IFNULL(p.isHidden, 0) = 0');
    }

    const replacements: Record<string, unknown> = {
      playerId,
      includeHidden: includeHiddenPasses ? 1 : 0,
    };
    const rawQuery = typeof opts.query === 'string' ? opts.query.trim() : '';
    let searchJoinSql = '';
    if (rawQuery.length > 0) {
      const like = `%${escapeForMySQL(rawQuery).toLowerCase()}%`;
      replacements.search = like;
      searchJoinSql = `
        LEFT JOIN teams tm ON tm.id = l.teamId
        LEFT JOIN level_credits lc ON lc.levelId = l.id
        LEFT JOIN creators cr ON cr.id = lc.creatorId
      `;
      filterClauses.push(`(
        LOWER(l.song) LIKE :search
        OR LOWER(l.artist) LIKE :search
        OR LOWER(IFNULL(tm.name, '')) LIKE :search
        OR LOWER(IFNULL(d.name, '')) LIKE :search
        OR LOWER(IFNULL(cr.name, '')) LIKE :search
      )`);
    }

    let orderSql: string;
    switch (sortBy) {
      case 'speed':
        orderSql = `p.speed ${dir}, p.scoreV2 ${dir}, p.id DESC`;
        break;
      case 'date':
        orderSql = `p.vidUploadTime ${dir}, p.id DESC`;
        break;
      case 'xacc':
        orderSql = `j.accuracy ${dir}, p.scoreV2 ${dir}, p.id DESC`;
        break;
      case 'difficulty':
        orderSql = `
          CASE WHEN d.type = 'PGU' THEN 0 ELSE 1 END ${inv},
          d.sortOrder ${dir},
          COALESCE(l.baseScore, d.baseScore, 0) ${inv},
          p.id DESC
        `;
        break;
      case 'impact':
        // Mirrors `getEnrichedPlayer` topScores / potentialTopScores: best
        // non-duplicate pass per level, then scoreV2 * 0.9^(rank-1) for the
        // top 20 of the stricter list (level available) or else the potential list.
        orderSql = `ic.sort_impact ${dir}, p.scoreV2 ${dir}, p.id DESC`;
        break;
      case 'score':
      default:
        orderSql = `p.scoreV2 ${dir}, p.id DESC`;
        break;
    }

    const baseFrom = `
      FROM passes p
      INNER JOIN levels l ON l.id = p.levelId
      LEFT JOIN difficulties d ON d.id = l.diffId
      LEFT JOIN judgements j ON j.id = p.id
      ${searchJoinSql}
      WHERE ${filterClauses.join(' AND ')}
    `;

    const impactSortCte = `
WITH base AS (
  SELECT p.id, p.levelId, p.scoreV2, p.isDuplicate,
    ROW_NUMBER() OVER (PARTITION BY p.levelId ORDER BY p.scoreV2 DESC, p.id DESC) AS rn_level
  FROM passes p
  INNER JOIN levels l ON l.id = p.levelId AND IFNULL(l.isDeleted, 0) = 0
  WHERE p.playerId = :playerId
    AND IFNULL(p.isDeleted, 0) = 0
    AND (:includeHidden = 1 OR IFNULL(p.isHidden, 0) = 0)
),
uniq AS (
  SELECT b.id, b.scoreV2,
    IFNULL(l.isExternallyAvailable, 0) AS ext_avail,
    IFNULL(l.dlLink, '') AS dl_link,
    IFNULL(l.workshopLink, '') AS ws_link
  FROM base b
  INNER JOIN levels l ON l.id = b.levelId
  WHERE b.rn_level = 1 AND IFNULL(b.isDuplicate, 0) = 0
),
top_ranked AS (
  SELECT id, scoreV2,
    ROW_NUMBER() OVER (ORDER BY scoreV2 DESC, id DESC) AS rnk
  FROM uniq
  WHERE ext_avail = 1 OR TRIM(dl_link) != '' OR TRIM(ws_link) != ''
),
top_impact AS (
  SELECT id, (scoreV2 * POW(0.9, rnk - 1)) AS impact_val
  FROM top_ranked
  WHERE rnk <= 20
),
pot_ranked AS (
  SELECT id, scoreV2,
    ROW_NUMBER() OVER (ORDER BY scoreV2 DESC, id DESC) AS rnk
  FROM uniq
),
pot_impact AS (
  SELECT id, (scoreV2 * POW(0.9, rnk - 1)) AS impact_val
  FROM pot_ranked
  WHERE rnk <= 20
),
impact_calc AS (
  SELECT p.id AS pass_id,
    COALESCE(ti.impact_val, pi.impact_val, 0) AS sort_impact
  FROM passes p
  LEFT JOIN top_impact ti ON ti.id = p.id
  LEFT JOIN pot_impact pi ON pi.id = p.id AND ti.id IS NULL
  WHERE p.playerId = :playerId
    AND IFNULL(p.isDeleted, 0) = 0
    AND (:includeHidden = 1 OR IFNULL(p.isHidden, 0) = 0)
)
`;

    const idFrom =
      sortBy === 'impact'
        ? `
      FROM passes p
      INNER JOIN levels l ON l.id = p.levelId
      LEFT JOIN difficulties d ON d.id = l.diffId
      LEFT JOIN judgements j ON j.id = p.id
      INNER JOIN impact_calc ic ON ic.pass_id = p.id
      ${searchJoinSql}
      WHERE ${filterClauses.join(' AND ')}
    `
        : baseFrom;

    const groupByCols = sortBy === 'impact' ? 'p.id, ic.sort_impact' : 'p.id';

    // DISTINCT p.id + COUNT on the outer select keeps the counts right even
    // when the search join fans out via level_credits.
    const idSql = `
      ${sortBy === 'impact' ? impactSortCte : ''}
      SELECT p.id AS id
      ${idFrom}
      GROUP BY ${groupByCols}
      ORDER BY ${orderSql}
      LIMIT :limit OFFSET :offset
    `;
    const countSql = `
      SELECT COUNT(*) AS total FROM (
        SELECT p.id ${baseFrom} GROUP BY p.id
      ) AS t
    `;

    const [idRows, countRows] = await Promise.all([
      sequelize.query(idSql, {
        replacements: { ...replacements, limit, offset },
        type: QueryTypes.SELECT,
      }) as Promise<Array<{ id: number }>>,
      sequelize.query(countSql, {
        replacements,
        type: QueryTypes.SELECT,
      }) as Promise<Array<{ total: number }>>,
    ]);

    const total = Number(countRows[0]?.total) || 0;
    const orderedIds = idRows.map(r => Number(r.id)).filter(Number.isFinite);
    if (orderedIds.length === 0) {
      return { total, passes: [] };
    }

    // --- Phase 2: hydrate the trimmed attribute tree for those ids. ---
    const passAttributes = [
      'id',
      'levelId',
      'scoreV2',
      'accuracy',
      'speed',
      'vidUploadTime',
      'videoLink',
      'isHidden',
      'isWorldsFirst',
      'isDuplicate',
    ];
    const levelAttributes = ['id', 'song', 'artist', 'diffId', 'baseScore', 'isHidden'];
    const judgementAttributes = [
      'id',
      'earlyDouble',
      'earlySingle',
      'ePerfect',
      'perfect',
      'lPerfect',
      'lateSingle',
    ];

    const fetched = await Pass.findAll({
      where: { id: { [Op.in]: orderedIds } },
      attributes: passAttributes,
      include: [
        {
          model: Level,
          as: 'level',
          attributes: levelAttributes,
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              attributes: ['id', 'name', 'type', 'sortOrder', 'baseScore'],
            },
            {
              model: LevelCredit,
              as: 'levelCredits',
              attributes: ['role'],
              required: false,
              include: [
                {
                  model: Creator,
                  as: 'creator',
                  attributes: ['name'],
                  required: false,
                },
              ],
            },
          ],
        },
        {
          model: Judgement,
          as: 'judgements',
          attributes: judgementAttributes,
          required: false,
        },
      ],
    });

    // Re-order to match phase-1 ordering (id IN (...) does not preserve order).
    const byId = new Map<number, Pass>();
    for (const p of fetched) byId.set((p as any).id, p);
    const passes = orderedIds
      .map(id => byId.get(id))
      .filter((p): p is Pass => Boolean(p));

    return { total, passes };
  }
}