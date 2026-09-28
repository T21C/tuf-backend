import { applyDerivedPerfects, cloneJudgements, type IJudgements } from './CalcAcc.js';
import {
  ADOFAI_VERSION,
  canUseXPerfectMode,
  isAdofaiV2FromVersion,
  isLegacyAdofaiVersion,
  parseAdofaiVersion,
  type AdofaiVersion,
} from './adofaiVersion.js';
import { applyMidspinPerfectDecrement } from './midspinPerfectDecrement.js';
import {
  addPassMetaFlag,
  passMetaFlags,
  passMetaFlagsToDb,
  toPassMetaFlags,
} from './passMetaFlags.js';

export function resolveSubmitAdofaiVersion(body: Record<string, unknown>): AdofaiVersion {
  if (body.adofaiVersion !== undefined && body.adofaiVersion !== null && body.adofaiVersion !== '') {
    return parseAdofaiVersion(body.adofaiVersion, ADOFAI_VERSION.PRE_3_4_0);
  }
  const legacy = body.isAdofaiV2 === true || body.isAdofaiV2 === 'true';
  return legacy ? ADOFAI_VERSION.V2 : ADOFAI_VERSION.PRE_3_4_0;
}

export function constrainXPerfect(
  judgements: IJudgements,
  adofaiVersion: number,
  isXPerfectMode: boolean,
): { judgements: IJudgements; isXPerfectMode: boolean } {
  const mode = canUseXPerfectMode(adofaiVersion) && !!isXPerfectMode;
  const next = cloneJudgements(judgements);
  if (!mode) {
    next.perfectMinus = 0;
    next.perfectPlus = 0;
  }
  return { judgements: next, isXPerfectMode: mode };
}

export function preparePassJudgementsForPersist(params: {
  judgements: IJudgements;
  adofaiVersion: number;
  isXPerfectMode: boolean;
  passMetaFlags?: unknown;
  midspinCount: unknown;
  tilecount?: unknown;
  autoTileCount?: unknown;
}) {
  const constrained = constrainXPerfect(
    params.judgements,
    params.adofaiVersion,
    params.isXPerfectMode,
  );
  const derived = applyDerivedPerfects({
    judgements: constrained.judgements,
    tilecount: params.tilecount,
    autoTileCount: params.autoTileCount,
  });
  let flags = toPassMetaFlags(params.passMetaFlags);
  if (derived.applied && isLegacyAdofaiVersion(params.adofaiVersion)) {
    flags = addPassMetaFlag(flags, passMetaFlags.MIDSPIN_PERFECTS_REMOVED);
  }
  const decrement = applyMidspinPerfectDecrement({
    judgements: derived.judgements,
    adofaiVersion: params.adofaiVersion,
    passMetaFlags: flags,
    midspinCount: params.midspinCount,
  });
  return {
    judgements: decrement.judgements,
    isXPerfectMode: constrained.isXPerfectMode,
    isAdofaiV2: isAdofaiV2FromVersion(params.adofaiVersion),
    passMetaFlags: decrement.passMetaFlags,
    passMetaFlagsDb: passMetaFlagsToDb(decrement.passMetaFlags),
    decrement,
    derived,
  };
}
