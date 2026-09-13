import { IJudgements, JUDGEMENT_KEYS, emptyJudgements } from './CalcAcc.js';

export const MAX_JUDGEMENT_VALUE = 2147483647;

export { JUDGEMENT_KEYS };

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
  const out = emptyJudgements();
  for (const key of JUDGEMENT_KEYS) {
    out[key] = sanitizeJudgementInt(obj[key], max);
  }
  return out;
}
