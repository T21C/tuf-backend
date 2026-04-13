import { IJudgements } from './CalcAcc.js';

export const MAX_JUDGEMENT_VALUE = 2147483647;

const JUDGEMENT_KEYS: Array<keyof IJudgements> = [
  'earlyDouble',
  'earlySingle',
  'ePerfect',
  'perfect',
  'lPerfect',
  'lateSingle',
  'lateDouble',
];

export function sanitizeJudgementInt(
  input: unknown,
  max: number = MAX_JUDGEMENT_VALUE,
): number {
  const parsed = parseInt(String(input ?? '0'), 10);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(max, parsed));
}

export function sanitizeJudgements(
  input: unknown,
  max: number = MAX_JUDGEMENT_VALUE,
): IJudgements {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  const out: Partial<IJudgements> = {};
  for (const key of JUDGEMENT_KEYS) {
    out[key] = sanitizeJudgementInt(obj[key], max);
  }
  return out as IJudgements;
}

