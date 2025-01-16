import {ILevel, IPass, IPlayer} from '../interfaces/models';
import Player from '../models/Player';
import Pass from '../models/Pass';
import Level from '../models/Level';
import Difficulty from '../models/Difficulty';
import Judgement from '../models/Judgement';
import { User } from '../models';
import OAuthProvider from '../models/OAuthProvider';
import {Worker} from 'worker_threads';
import path from 'path';
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
const CONCURRENT_BATCH_SIZE = 25; // Number of players to process in parallel
const DELAY_BETWEEN_BATCHES = 100; // Small delay between batches
const PLAYER_LOAD_BATCH_SIZE = 50; // Reduced batch size for better memory management

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

// Worker pool configuration
const MAX_WORKERS = Math.max(1, Math.min(4, Math.floor(require('os').cpus().length / 2)));
const workerPool: Worker[] = [];

// Initialize worker pool
function initializeWorkerPool() {
  for (let i = 0; i < MAX_WORKERS; i++) {
    const worker = new Worker(path.join(__dirname, 'statsWorker.js'));
    workerPool.push(worker);
  }
}

// Get next available worker
function getWorker(): Worker {
  return workerPool[Math.floor(Math.random() * workerPool.length)];
}

// Process stats calculation in worker thread
async function calculateStatsInWorker(scores: any[], passes: any[]): Promise<any> {
  const worker = getWorker();
  return new Promise((resolve, reject) => {
    worker.postMessage({ scores, passes });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

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
  // Initialize worker pool if not already done
  if (workerPool.length === 0) {
    initializeWorkerPool();
  }

  // Split the data loading into parallel operations
  const [userData, passesData] = await Promise.all([
    // Load user data
    User.findOne({
      where: { playerId: player.id },
      include: [{
        model: OAuthProvider,
        as: 'providers',
        where: { provider: 'discord' },
        attributes: ['profile'],
        required: false
      }],
      attributes: ['nickname', 'avatarUrl', 'username']
    }),
    // Load passes with minimal data
    Pass.findAll({
      where: { 
        playerId: player.id,
        isDeleted: false
      },
      attributes: [
        'id', 'scoreV2', 'accuracy', 'isWorldsFirst', 
        'is12K', 'isDeleted', 'levelId'
      ],
      include: [{
        model: Level,
        as: 'level',
        attributes: ['id', 'baseScore', 'isHidden'],
        include: [{
          model: Difficulty,
          as: 'difficulty',
          attributes: ['name', 'sortOrder']
        }]
      }]
    })
  ]);

  const playerData = player.get({plain: true});
  
  // Process passes data
  const scores = passesData
    .filter(pass => !pass.isDeleted)
    .map(pass => ({
      score: pass.scoreV2 || 0,
      xacc: pass.accuracy || 0,
      isWorldsFirst: pass.isWorldsFirst || false,
      is12K: pass.is12K || false,
      baseScore: pass.level?.baseScore || 0,
      isDeleted: pass.isDeleted || false,
      isHidden: pass.level?.isHidden || false,
      pguDiff: pass.level?.difficulty?.name,
      diffSortOrder: pass.level?.difficulty?.sortOrder
    }));

  // Process Discord data
  let discordProvider: any;
  if (userData?.dataValues.providers) {
    discordProvider = userData.dataValues.providers[0].dataValues;
    discordProvider.profile.avatarUrl = discordProvider.profile.avatar ? 
      `https://cdn.discordapp.com/avatars/${discordProvider.profile.id}/${discordProvider.profile.avatar}.png` :
      null;
  }

  // Calculate stats in worker thread
  const stats = await calculateStatsInWorker(scores, passesData);

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
    ...stats,
    totalPasses: scores.length,
    createdAt: playerData.createdAt,
    updatedAt: playerData.updatedAt,
    passes: passesData,
  } as IPlayer;

  return enrichedPlayer;
}

export async function updateAllPlayerPfps(): Promise<void> {
  const mainBar = progressBar.create(100, 0, {
    task: 'PFP Update',
    subtask: 'Starting...'
  });

  try {
    mainBar.update(10, { subtask: 'Loading players' });
    const players = await loadPlayersInBatches(mainBar);

    if (players.length === 0) {
      mainBar.update(100, { subtask: 'No updates needed' });
      return;
    }

    mainBar.update(20, { subtask: `Processing ${players.length} players` });

    // Process players in smaller batches to manage memory and connection load
    const batches = [];
    for (let i = 0; i < players.length; i += CONCURRENT_BATCH_SIZE) {
      const batch = players.slice(i, i + CONCURRENT_BATCH_SIZE);
      batches.push(batch);
    }

    let totalSuccesses = 0;
    let totalFailures = 0;

    for (let i = 0; i < batches.length; i++) {
      const startProgress = 20 + ((i / batches.length) * 70);
      const endProgress = 20 + (((i + 1) / batches.length) * 70);
      
      mainBar.update(startProgress, { 
        subtask: `Processing batch ${i + 1}/${batches.length}` 
      });

      try {
        const results = await processBatch(batches[i], mainBar, startProgress, endProgress);
        const batchSuccesses = results.filter(r => r.success).length;
        totalSuccesses += batchSuccesses;
        totalFailures += results.length - batchSuccesses;

        // Add a small delay between batches to prevent overload
        if (i < batches.length - 1) {
          await delay(DELAY_BETWEEN_BATCHES);
        }
      } catch (error) {
        console.error(`Error processing batch ${i + 1}:`, error);
        // Log error but continue with next batch
        totalFailures += batches[i].length;
        mainBar.update(endProgress, { 
          subtask: `Batch ${i + 1} failed, continuing...` 
        });
      }
    }

    mainBar.update(100, { 
      subtask: `Complete (${totalSuccesses} updated, ${totalFailures} failed)` 
    });
  } catch (error) {
    console.error('Error in updateAllPlayerPfps:', error);
    mainBar.update(100, { subtask: 'Failed' });
    throw error;
  } finally {
    mainBar.stop();
    progressBar.remove(mainBar);
  }
}
