import { IPlayer, IPass } from '../types/models';
import { calcAcc } from '../misc/CalcAcc';
import { getScoreV2 } from '../misc/CalcScore';
import { getPfpUrl } from './pfpResolver';
import Player from '../models/Player';
import Pass from '../models/Pass';

// Rate limiting settings
const CONCURRENT_BATCH_SIZE = 25; // Process 10 players concurrently
const DELAY_BETWEEN_BATCHES = 0; // 5 seconds between batches

// Helper function to delay execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function updatePlayerPfp(player: Player): Promise<{ 
  playerId: number, 
  playerName: string, 
  success: boolean, 
  pfpUrl: string | null, 
  error?: string 
}> {
  try {
    // Get raw data to ensure we have the ID
    const playerData = player.get({ plain: true });
    if (!playerData.id) {
      return {
        playerId: -1,
        playerName: playerData.name,
        success: false,
        pfpUrl: null,
        error: 'No player ID found'
      };
    }

    // Skip if pfp is already set and not null
    if (playerData.pfp !== null) {
      return {
        playerId: playerData.id,
        playerName: playerData.name,
        success: true,
        pfpUrl: playerData.pfp,
        error: 'PFP already set'
      };
    }

    // Get up to 20 passes with video links
    const validPasses = (player.playerPasses || [])
      .filter(pass => pass.vidLink && !pass.isDeleted)
      .slice(0, 20);

    if (validPasses.length === 0) {
      // Update database to mark as processed with no pfp
      await Player.update(
        { pfp: 'none' },
        { where: { id: playerData.id } }
      );
      
      return {
        playerId: playerData.id,
        playerName: playerData.name,
        success: true,
        pfpUrl: 'none',
        error: 'No valid video links found'
      };
    }

    console.log(`Processing player ${playerData.name} (ID: ${playerData.id}) with ${validPasses.length} videos`);

    // Try each video link until we get a valid pfp
    for (const pass of validPasses) {
      try {
        console.log(`Trying video ${pass.vidLink} for player ${playerData.name}`);
        const pfpUrl = await getPfpUrl(pass.vidLink!);
        
        if (pfpUrl) {
          // Update player's pfp in database
          await Player.update(
            { pfp: pfpUrl },
            { where: { id: playerData.id } }
          );

          console.log(`✓ Success: Updated pfp for ${playerData.name} using video ${pass.vidLink}`);
          return {
            playerId: playerData.id,
            playerName: playerData.name,
            success: true,
            pfpUrl: pfpUrl
          };
        }
      } catch (error) {
        console.log(`✗ Failed to get pfp from video ${pass.vidLink} for ${playerData.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        continue;
      }
    }

    // If no pfp was found after trying all videos, mark as processed with no pfp
    await Player.update(
      { pfp: 'none' },
      { where: { id: playerData.id } }
    );

    return {
      playerId: playerData.id,
      playerName: playerData.name,
      success: true,
      pfpUrl: 'none',
      error: `No valid pfp found after trying ${validPasses.length} videos`
    };
  } catch (error) {
    return {
      playerId: player.id,
      playerName: player.name,
      success: false,
      pfpUrl: null,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

async function processBatch(players: Player[]): Promise<Array<{ 
  playerId: number, 
  playerName: string, 
  success: boolean, 
  pfpUrl: string | null, 
  error?: string 
}>> {
  console.log(`\nProcessing batch of ${players.length} players concurrently...`);
  const startTime = Date.now();
  
  const results = await Promise.all(players.map(updatePlayerPfp));
  
  const successCount = results.filter(r => r.success).length;
  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000;
  
  console.log(`\nBatch complete:`);
  console.log(`✓ Successful updates: ${successCount}/${players.length}`);
  console.log(`✗ Failed updates: ${players.length - successCount}/${players.length}`);
  console.log(`⏱ Duration: ${duration.toFixed(2)} seconds`);
  
  return results;
}

export async function updateAllPlayerPfps(): Promise<void> {
  try {
    console.log('\n=== Starting pfp update process ===\n');
    
    const players = await Player.findAll({
      where: {
        pfp: null // Only get players with null pfp
      },
      include: [{
        model: Pass,
        as: 'playerPasses',
        attributes: ['vidLink', 'isDeleted']
      }]
    });

    console.log(`Found ${players.length} players with null pfp to process`);

    if (players.length === 0) {
      console.log('No players need pfp updates');
      return;
    }

    // Process players in concurrent batches
    const batches = [];
    for (let i = 0; i < players.length; i += CONCURRENT_BATCH_SIZE) {
      const batch = players.slice(i, i + CONCURRENT_BATCH_SIZE);
      batches.push(batch);
    }

    console.log(`Split into ${batches.length} batches of ${CONCURRENT_BATCH_SIZE} players each\n`);

    let totalSuccesses = 0;
    let totalFailures = 0;
    const startTime = Date.now();

    for (let i = 0; i < batches.length; i++) {
      console.log(`\n=== Processing Batch ${i + 1}/${batches.length} ===`);
      
      const results = await processBatch(batches[i]);
      const batchSuccesses = results.filter(r => r.success).length;
      const batchFailures = results.length - batchSuccesses;
      
      totalSuccesses += batchSuccesses;
      totalFailures += batchFailures;
      
      // Add delay between batches (except for the last batch)
      if (i < batches.length - 1) {
        console.log(`\nWaiting ${DELAY_BETWEEN_BATCHES/1000} seconds before next batch...`);
        await delay(DELAY_BETWEEN_BATCHES);
      }
    }
    
    const endTime = Date.now();
    const totalDuration = (endTime - startTime) / 1000;
    
    console.log('\n=== Pfp Update Process Complete ===');
    console.log(`Total Duration: ${totalDuration.toFixed(2)} seconds`);
    console.log(`Total Successes: ${totalSuccesses}/${players.length}`);
    console.log(`Total Failures: ${totalFailures}/${players.length}`);
    console.log('===================================\n');
  } catch (error) {
    console.error('Error updating player pfps:', error);
  }
}

interface Score {
  score: number;
  xacc: number;
  isWorldsFirst: boolean;
  is12K: boolean;
  baseScore: number;
  isDeleted: boolean;
  pguDiff?: string;
}

interface PGUSort {
  [key: string]: number;
  P: number;
  G: number;
  U: number;
}

const PGU_SORT: PGUSort = {
  P: 1,
  G: 2,
  U: 3
};

export async function enrichPlayerData(player: Player): Promise<IPlayer> {
  // Get raw data values from Sequelize instance
  const playerData = player.get({ plain: true });
  const passes = playerData.playerPasses || [];
  
  // Calculate scores and stats
  const scores: Score[] = passes
    .filter((pass: any) => !pass.isDeleted)
    .map((pass: any) => ({
      score: pass.scoreV2 || 0,
      xacc: pass.accuracy || 0,
      isWorldsFirst: pass.isWorldsFirst || false,
      is12K: pass.is12K || false,
      baseScore: pass.level?.baseScore || 0,
      isDeleted: pass.isDeleted || false,
      pguDiff: pass.level?.pguDiff
    }));

  // Calculate player stats
  const validScores = scores.filter(s => !s.isDeleted);
  
  const enrichedPlayer = {
    id: playerData.id,
    name: playerData.name,
    country: playerData.country,
    isBanned: playerData.isBanned,
    pfp: playerData.pfp,
    rankedScore: calculateRankedScore(validScores),
    generalScore: calculateGeneralScore(validScores),
    ppScore: calculatePPScore(validScores),
    wfScore: calculateWFScore(validScores),
    score12k: calculate12KScore(validScores),
    avgXacc: calculateAverageXacc(validScores),
    totalPasses: validScores.length,
    universalPasses: countUniversalPasses(passes),
    WFPasses: countWorldsFirstPasses(passes),
    topDiff: calculateTopDiff(passes),
    top12kDiff: calculateTop12KDiff(passes),
    createdAt: playerData.createdAt,
    updatedAt: playerData.updatedAt,
    playerPasses: passes
  } as IPlayer;

  return enrichedPlayer;
}

function calculateRankedScore(scores: Score[]): number {
  if (scores.length === 0) return 0;
  return scores
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .reduce((acc, score, index) => acc + score.score * Math.pow(0.9, index), 0);
}

function calculateGeneralScore(scores: Score[]): number {
  if (scores.length === 0) return 0;
  return scores.reduce((sum, score) => sum + score.score, 0);
}

function calculatePPScore(scores: Score[]): number {
  if (scores.length === 0) return 0;
  return scores
    .filter(score => score.xacc === 1.0)
    .reduce((sum, score) => sum + score.score, 0);
}

function calculateWFScore(scores: Score[]): number {
  if (scores.length === 0) return 0;
  return scores
    .filter(score => score.isWorldsFirst)
    .reduce((sum, score) => sum + score.baseScore, 0);
}

function calculate12KScore(scores: Score[]): number {
  if (scores.length === 0) return 0;
  return scores
    .filter(score => score.is12K)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .reduce((acc, score, index) => acc + score.score * Math.pow(0.95, index), 0);
}

function calculateAverageXacc(scores: Score[]): number {
  if (scores.length === 0) return 0;
  const topScores = scores
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  return topScores.reduce((sum, score) => sum + score.xacc, 0) / topScores.length;
}

function countUniversalPasses(passes: any[]): number {
  return passes.filter(pass => 
    !pass.isDeleted && pass.level?.pguDiff?.startsWith('U')
  ).length;
}

function countWorldsFirstPasses(passes: any[]): number {
  return passes.filter(pass => !pass.isDeleted && pass.isWorldsFirst).length;
}

function calculateTopDiff(passes: any[]): string {
  return calculateDiff(passes, false);
}

function calculateTop12KDiff(passes: any[]): string {
  return calculateDiff(passes, true);
}

function calculateDiff(passes: any[], only12k: boolean): string {
  let topLetter = 'P';
  let topNumber = 1;

  const validPasses = passes.filter(pass => !pass.isDeleted && (!only12k || pass.is12K));
  if (validPasses.length === 0) return 'P1';

  validPasses.forEach(pass => {
    const pguDiff = pass.level?.pguDiff;
    if (!pguDiff) return;

    const letter = pguDiff[0];
    const number = parseInt(pguDiff.slice(1));

    if (PGU_SORT[letter] > PGU_SORT[topLetter] || 
       (PGU_SORT[letter] === PGU_SORT[topLetter] && number > topNumber)) {
      topLetter = letter;
      topNumber = number;
    }
  });

  return `${topLetter}${topNumber}`;
}