import {ILevel, IPass, IPlayer} from '../interfaces/models';
import Player from '../models/Player';
import Pass from '../models/Pass';
import Level from '../models/Level';
import Judgement from '../models/Judgement';
import { User } from '../models';
import OAuthProvider from '../models/OAuthProvider';
import {
  calculateRankedScore,
  calculateGeneralScore,
  calculatePPScore,
  calculateWFScore,
  calculate12KScore,
  calculateAverageXacc,
  countUniversalPasses,
  countWorldsFirstPasses,
  calculateTopDiff,
  calculateTop12KDiff,
} from '../misc/PlayerStatsCalculator';
import {getPfpUrl} from './pfpResolver';
import {getBaseScore} from './parseBaseScore';
import cliProgress from 'cli-progress';
import colors from 'ansi-colors';
import sequelize from '../config/db';

// Rate limiting settings
const DELAY_BETWEEN_BATCHES = 100; // Small delay between batches
const PLAYER_LOAD_BATCH_SIZE = 100; // Reduced batch size for better memory management

// Progress bar configuration
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

// Helper function to delay execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function updatePlayerPfp(player: Player): Promise<{
  playerId: number;
  playerName: string;
  success: boolean;
  pfpUrl: string | null;
  error?: string;
}> {
  try {
    const playerData = player.get({plain: true});
    if (!playerData.id) {
      return {
        playerId: -1,
        playerName: playerData.name,
        success: false,
        pfpUrl: null,
        error: 'No player ID found',
      };
    }

    if (playerData.pfp !== null) {
      return {
        playerId: playerData.id,
        playerName: playerData.name,
        success: true,
        pfpUrl: playerData.pfp || null,
        error: 'PFP already set',
      };
    }

    const validPasses = (player.passes || [])
      .filter(pass => pass.videoLink && !pass.isDeleted)
      .slice(0, 20);

    if (validPasses.length === 0) {
      await Player.update({pfp: 'none'}, {where: {id: playerData.id}});
      return {
        playerId: playerData.id,
        playerName: playerData.name,
        success: true,
        pfpUrl: 'none',
        error: 'No valid video links found',
      };
    }

    for (const pass of validPasses) {
      try {
        const pfpUrl = await getPfpUrl(pass.videoLink!);
        if (pfpUrl) {
          await Player.update({pfp: pfpUrl}, {where: {id: playerData.id}});
          return {
            playerId: playerData.id,
            playerName: playerData.name,
            success: true,
            pfpUrl: pfpUrl,
          };
        }
      } catch (error) {
        continue;
      }
    }

    await Player.update({pfp: 'none'}, {where: {id: playerData.id}});
    return {
      playerId: playerData.id,
      playerName: playerData.name,
      success: true,
      pfpUrl: 'none',
      error: `No valid pfp found after trying ${validPasses.length} videos`,
    };
  } catch (error) {
    return {
      playerId: player.id,
      playerName: player.name,
      success: false,
      pfpUrl: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function loadPlayersInBatches(mainBar: cliProgress.SingleBar): Promise<Player[]> {
  // First get total count and IDs
  const totalCount = await Player.count({
    where: { pfp: null }
  });

  if (totalCount === 0) {
    return [];
  }

  const allPlayers: Player[] = [];
  const totalBatches = Math.ceil(totalCount / PLAYER_LOAD_BATCH_SIZE);

  // Load players in batches with optimized includes
  for (let batch = 0; batch < totalBatches; batch++) {
    const progress = 10 + ((batch / totalBatches) * 10);
    mainBar.update(progress, { subtask: `Loading players (batch ${batch + 1}/${totalBatches})` });

    try {
      const batchPlayers = await Player.findAll({
        where: { pfp: null },
        include: [
          {
            model: Pass,
            as: 'passes',
            required: false,
            where: { isDeleted: false },
            attributes: ['videoLink', 'isDeleted'],
            limit: 20, // Only need first 20 passes for pfp
            include: [
              {
                model: Level,
                as: 'level',
                attributes: ['id'],
              },
            ],
          },
        ],
        limit: PLAYER_LOAD_BATCH_SIZE,
        offset: batch * PLAYER_LOAD_BATCH_SIZE,
        order: [['id', 'ASC']],
      });

      allPlayers.push(...batchPlayers);

      // Small delay between batches to prevent overloading
      if (batch < totalBatches - 1) {
        await delay(DELAY_BETWEEN_BATCHES);
      }
    } catch (error) {
      console.error(`Error loading batch ${batch + 1}:`, error);
      // Continue with next batch despite errors
      continue;
    }
  }

  return allPlayers;
}

async function processBatch(
  players: Player[], 
  progressBar: cliProgress.SingleBar, 
  startProgress: number, 
  endProgress: number
): Promise<Array<{
  playerId: number;
  playerName: string;
  success: boolean;
  pfpUrl: string | null;
  error?: string;
}>> {
  const results = await Promise.all(
    players.map(async (player, index) => {
      const progress = startProgress + ((index / players.length) * (endProgress - startProgress));
      progressBar.update(progress, { subtask: `Processing ${player.name}` });
      
      try {
        return await updatePlayerPfp(player);
      } catch (error) {
        return {
          playerId: player.id,
          playerName: player.name,
          success: false,
          pfpUrl: null,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    })
  );
  return results;
}

export async function enrichPlayerData(player: Player): Promise<IPlayer> {
  // Load user data in parallel with pass processing
  const userDataPromise = User.findOne({
    where: { playerId: player.id },
    include: [{
      model: OAuthProvider,
      as: 'providers',
      where: { provider: 'discord' },
      attributes: ['profile'],
      required: false
    }],
    attributes: ['nickname', 'avatarUrl', 'username']
  });

  const playerData = player.get({plain: true});
  const passes = playerData.passes || [];

  // Process passes while user data is being fetched
  const scores = passes
    .filter((pass: IPass) => !pass.isDeleted)
    .map((pass: IPass) => ({
      score: pass.scoreV2 || 0,
      xacc: pass.accuracy || 0,
      isWorldsFirst: pass.isWorldsFirst || false,
      is12K: pass.is12K || false,
      baseScore: getBaseScore(pass.level as ILevel),
      isDeleted: pass.isDeleted || false,
      isHidden: pass.level?.isHidden || false,
      pguDiff: pass.level?.difficulty?.name,
    }));

  const validScores = scores.filter((s: any) => !s.isDeleted);

  // Wait for user data
  const userData = await userDataPromise;

  let discordProvider: any;
  if (userData?.dataValues.providers) {
    discordProvider = userData?.dataValues.providers[0].dataValues as any;
    discordProvider.profile.avatarUrl = discordProvider.profile.avatar ? 
      `https://cdn.discordapp.com/avatars/${discordProvider.profile.id}/${discordProvider.profile.avatar}.png` :
      null;
  }

  // Calculate all stats in parallel
  const [
    rankedScore,
    generalScore,
    ppScore,
    wfScore,
    score12k,
    averageXacc,
    universalPassCount,
    worldsFirstCount,
    topDiff,
    top12kDiff
  ] = await Promise.all([
    calculateRankedScore(validScores),
    calculateGeneralScore(validScores),
    calculatePPScore(validScores),
    calculateWFScore(validScores),
    calculate12KScore(validScores),
    calculateAverageXacc(validScores),
    countUniversalPasses(passes),
    countWorldsFirstPasses(passes),
    calculateTopDiff(passes),
    calculateTop12KDiff(passes)
  ]);

  const enrichedPlayer = {
    id: playerData.id,
    name: playerData.name,
    country: playerData.country,
    isBanned: playerData.isBanned,
    pfp: userData?.avatarUrl || playerData.pfp,
    discordUsername: userData?.username,
    discordAvatar: discordProvider?.profile.avatarUrl,
    discordAvatarId: discordProvider?.profile.avatar,
    discordId: discordProvider?.profile.id,
    rankedScore,
    generalScore,
    ppScore,
    wfScore,
    score12k,
    averageXacc,
    totalPasses: validScores.length,
    universalPasses: universalPassCount,
    worldsFirstCount,
    topDiff,
    top12kDiff,
    createdAt: playerData.createdAt,
    updatedAt: playerData.updatedAt,
    passes: passes,
  } as IPlayer;

  return enrichedPlayer;
}
