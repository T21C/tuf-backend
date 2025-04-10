import {IPassSubmission} from '../interfaces/models/index.js';
import {calcAcc, IJudgements, tilecount} from './CalcAcc.js';

const gmConst = 315;
const start = 1;
const end = 50;
const startDeduc = 10;
const endDeduc = 50;
const pwr = 0.7;

const getScoreV2Mtp = (inputs: IJudgements) => {
  const misses = inputs.earlyDouble;

  const tiles = tilecount(inputs);

  if (!misses) {
    return 1.1;
  }
  const tp = (start + end) / 2;
  const tpDeduc = (startDeduc + endDeduc) / 2;
  const am = Math.max(0, misses - Math.floor(tiles / gmConst));
  if (am === 0) {
    return 1;
  } else if (am <= start) {
    return 1 - startDeduc / 100;
  }
  if (am <= tp) {
    const kOne =
      (Math.pow((am - start) / (tp - start), pwr) * (tpDeduc - startDeduc)) /
      100;
    return 1 - startDeduc / 100 - kOne;
  } else if (am <= end) {
    const kTwo =
      (Math.pow((end - am) / (end - tp), pwr) * (endDeduc - tpDeduc)) / 100;
    return 1 + kTwo - endDeduc / 100;
  } else {
    return 1 - endDeduc / 100;
  }
};

const getXaccMtp = (inp: IJudgements) => {
  const xacc = calcAcc(inp);
  const xacc_percentage = xacc * 100;

  if (xacc_percentage < 95) {
    return 1;
  }
  if (xacc_percentage < 100) {
    return -0.027 / (xacc - 1.0054) + 0.513;
  }
  if (xacc_percentage === 100) {
    return 10;
  }
  return 1;
};

const getSpeedMtp = (speed: number, isDesBus = false) => {
  if (isDesBus) {
    if (!speed || speed === 1) return 1;
    else if (speed > 1) {
      return Math.max(2 - speed, 0);
    }
  }

  if (!speed || speed === 1) {
    return 1;
  }
  if (speed < 1) {
    return 0;
  }
  if (speed < 1.1) {
    return -3.5 * speed + 4.5;
  }
  if (speed < 1.5) {
    return 0.65;
  }
  if (speed < 2) {
    return 0.7 * speed - 0.4;
  }
  return 1;
};

const getScore = (passData: PassData, levelData: LevelData) => {
  const speed = passData.speed;
  const inputs = passData.judgements;
  const base = levelData.baseScore
    ? levelData.baseScore
    : levelData.difficulty?.baseScore || 0;
  const xaccMtp = getXaccMtp(inputs);

  let speedMtp = 0;
  let score = 0;
  if (levelData.difficulty?.name === "Marathon") {
    speedMtp = getSpeedMtp(speed, true);
    score = Math.max(base * xaccMtp * speedMtp, 1);
  } else {
    speedMtp = getSpeedMtp(speed);
    score = base * xaccMtp * speedMtp;
  }
  return score;
};

interface LevelData {
  baseScore: number | null;
  diff?: number;
  difficulty: {
    name: string;
    baseScore: number;
  };
}

interface PassData {
  speed: number;
  judgements: IJudgements;
  isNoHoldTap: boolean;
}

// Declare the overloads
export function getScoreV2(passData: PassData, levelData: LevelData): number;
export function getScoreV2(
  passSubmission: IPassSubmission,
  levelData: LevelData,
): number;
// Implement the function with a union type
export function getScoreV2(
  input: PassData | IPassSubmission,
  levelData: LevelData,
): number {
  // Type guard to determine which type we're dealing with
  const isPassSubmission = (
    input: PassData | IPassSubmission,
  ): input is IPassSubmission => 'judgements' in input && 'flags' in input;

  if (isPassSubmission(input)) {
    const inputs: IJudgements = input.judgements || {
      earlyDouble: 0,
      earlySingle: 0,
      ePerfect: 5,
      perfect: 40,
      lPerfect: 5,
      lateSingle: 0,
      lateDouble: 0,
    };
    const passData = {
      speed: input.speed || 1,
      judgements: inputs,
      isNoHoldTap: input.flags?.isNoHoldTap || false,
    };
    const scoreOrig = getScore(passData, levelData);
    let mtp = getScoreV2Mtp(inputs);
    if (input.flags?.isNoHoldTap === true) {
      mtp *= 0.9;
    }
    return scoreOrig * mtp;
  } else {
    const scoreOrig = getScore(input, levelData);
    let mtp = getScoreV2Mtp(input.judgements);
    if (input.isNoHoldTap === true) {
      mtp *= 0.9;
    }
    return scoreOrig * mtp;
  }
}
