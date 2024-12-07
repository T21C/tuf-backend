import { IPlayer, IPass } from '../types/models';
import { calcAcc } from '../misc/CalcAcc';
import { getScoreV2 } from '../misc/CalcScore';

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

export async function enrichPlayerData(player: any): Promise<IPlayer> {
  const passes = player.Passes || [];
  
  // Calculate scores and stats
  const scores: Score[] = passes.map((pass: any) => {
    const judgements = pass.Judgement;
    const level = pass.Level;
    
    return {
      score: getScoreV2({
        speed: pass.speed,
        judgements,
        isNoHoldTap: pass.isNoHoldTap
      }, {
        baseScore: level.baseScore
      }),
      xacc: calcAcc(judgements),
      isWorldsFirst: pass.isWorldsFirst,
      is12K: pass.is12K,
      baseScore: level.baseScore,
      isDeleted: pass.isDeleted,
      pguDiff: level.pguDiff
    };
  });

  // Calculate player stats
  const validScores = scores.filter(s => !s.isDeleted);
  
  return {
    id: player.id,
    name: player.name,
    country: player.country,
    isBanned: player.isBanned,
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
    createdAt: player.createdAt,
    updatedAt: player.updatedAt
  };
}

function calculateRankedScore(scores: Score[], top = 20): number {
  return scores
    .slice(0, top)
    .reduce((acc, score, index) => acc + score.score * Math.pow(0.9, index), 0);
}

function calculateGeneralScore(scores: Score[]): number {
  return scores.reduce((sum, score) => sum + score.score, 0);
}

function calculatePPScore(scores: Score[]): number {
  return scores
    .filter(score => score.xacc === 1.0)
    .reduce((sum, score) => sum + score.score, 0);
}

function calculateWFScore(scores: Score[]): number {
  return scores
    .filter(score => score.isWorldsFirst)
    .reduce((sum, score) => sum + score.baseScore, 0);
}

function calculate12KScore(scores: Score[]): number {
  return scores
    .filter(score => score.is12K)
    .slice(0, 20)
    .reduce((sum, score, index) => sum + score.score * Math.pow(0.9, index), 0);
}

function calculateAverageXacc(scores: Score[]): number {
  const topScores = scores.slice(0, 20);
  return topScores.length ? 
    topScores.reduce((sum, score) => sum + score.xacc, 0) / topScores.length : 0;
}

function countUniversalPasses(passes: any[]): number {
  return passes.filter(pass => 
    !pass.isDeleted && pass.Level?.pguDiff?.startsWith('U')
  ).length;
}

function countWorldsFirstPasses(passes: any[]): number {
  return passes.filter(pass => pass.isWorldsFirst).length;
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

  passes
    .filter(pass => !pass.isDeleted && (!only12k || pass.is12K))
    .forEach(pass => {
      const pguDiff = pass.Level?.pguDiff;
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