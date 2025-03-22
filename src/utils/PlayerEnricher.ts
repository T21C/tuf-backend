import {IPlayer} from '../interfaces/models/index.js';
import Player from '../models/Player.js';
import Pass from '../models/Pass.js';
import Level from '../models/Level.js';
import Difficulty from '../models/Difficulty.js';
import {User} from '../models/index.js';
import OAuthProvider from '../models/OAuthProvider.js';
import {PlayerStatsService} from '../services/PlayerStatsService.js';

// Process a batch of players in parallel
async function processBatchParallel(player: Player): Promise<IPlayer> {
  // First, get all player IDs
  const playerIds = player.id;

  // Load all passes for these players in one query
  const allPasses = await Pass.findAll({
    where: {
      playerId: playerIds,
      isDeleted: false,
    },
    include: [
      {
        model: Level,
        as: 'level',
        where: {
          isDeleted: false,
          isHidden: false,
        },
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
          },
        ],
      },
    ],
  });

  // Load all user data in one query
  const allUserData = await User.findAll({
    where: {playerId: playerIds},
    include: [
      {
        model: OAuthProvider,
        as: 'providers',
        where: {provider: 'discord'},
        attributes: ['profile'],
        required: false,
      },
    ],
    attributes: ['playerId', 'nickname', 'avatarUrl', 'username'],
  });

  const allDifficulties = await Difficulty.findAll();

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
      if (userData?.dataValues.providers) {
        discordProvider = userData.dataValues.providers[0].dataValues;
        discordProvider.profile.avatarUrl = discordProvider.profile.avatar
          ? `https://cdn.discordapp.com/avatars/${discordProvider.profile.id}/${discordProvider.profile.avatar}.png`
          : null;
      }

      // Get player stats from service
      const stats = await playerStatsService.getPlayerStats(player.id);

      // Find the actual difficulty objects from passes
      const getDifficulty = (id: number) => {
        const difficulty = allDifficulties.find(d => d.id === id);
        return difficulty;
      };

      return {
        id: playerData.id,
        name: playerData.name,
        country: playerData.country,
        isBanned: playerData.isBanned,
        isSubmissionsPaused: playerData.isSubmissionsPaused,
        pfp: playerData.pfp,
        avatarUrl: userData?.avatarUrl,
        discordUsername: userData?.username,
        discordAvatar: discordProvider?.profile.avatarUrl,
        discordAvatarId: discordProvider?.profile.avatar,
        discordId: discordProvider?.profile.id,
        rankedScore: stats?.rankedScore || 0,
        generalScore: stats?.generalScore || 0,
        ppScore: stats?.ppScore || 0,
        wfScore: stats?.wfScore || 0,
        score12K: stats?.score12K || 0,
        averageXacc: stats?.averageXacc || 0,
        universalPassCount: stats?.universalPassCount || 0,
        worldsFirstCount: stats?.worldsFirstCount || 0,
        topDiff: getDifficulty(stats?.topDiff || 0),
        top12kDiff: getDifficulty(stats?.top12kDiff || 0),
        totalPasses: passes.length,
        createdAt: playerData.createdAt,
        updatedAt: playerData.updatedAt,
        passes,
  } as IPlayer;
}

export async function enrichPlayerData(player: Player): Promise<IPlayer> {
  const enrichedPlayer = await processBatchParallel(player);
  return enrichedPlayer;
}

