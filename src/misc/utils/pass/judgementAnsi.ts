import { unwrapJudgements, type IJudgements } from './CalcAcc.js';
import { ADOFAI_VERSION } from './adofaiVersion.js';

export function shouldIncludeXPerfectAnsi(
  judgements: unknown,
  isXPerfectMode?: boolean | null,
): boolean {
  if (isXPerfectMode) return true;
  const j = unwrapJudgements(judgements);
  return j.perfectMinus > 0 || j.perfectPlus > 0;
}

export function formatJudgementAnsi(
  judgements: IJudgements | unknown,
  isXPerfectMode?: boolean | null,
): string {
  const j = unwrapJudgements(judgements);
  const showX = shouldIncludeXPerfectAnsi(j, isXPerfectMode);
  const perfectBand = showX
    ? `[1;37m${j.perfectMinus}[0m [1;32m${j.perfect}[0m [1;37m${j.perfectPlus}[0m`
    : `[1;32m${j.perfect}[0m`;
  return `\`\`\`ansi\n[2;31m${j.earlyDouble}[0m [2;33m${j.earlySingle}[0m [2;32m${j.ePerfect}[0m ${perfectBand} [2;32m${j.lPerfect}[0m [2;33m${j.lateSingle}[0m [2;31m${j.lateDouble}[0m\n\`\`\`\n`;
}

export function adofaiEraWebhookLabel(adofaiVersion: unknown): string | null {
  const n = typeof adofaiVersion === 'number' ? adofaiVersion : Number(adofaiVersion);
  if (n === ADOFAI_VERSION.V2) return 'ADOFAI v2';
  if (n === ADOFAI_VERSION.PRE_3_4_0) return '<3.4.0';
  return null;
}
