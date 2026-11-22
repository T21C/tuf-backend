import type { Curve, TierLabel } from './curve.js';
import { parseFormula } from './formula.js';
import { parseValueExpr } from './valueExpr.js';
import { JUDGEMENT_KEYS, type JudgementKey } from './judgement.js';
import type { IdentityMode } from './identity.js';

export type Audience = 'player' | 'creator';
export type ReducerName =
  | 'threshold'
  | 'coverage'
  | 'percentOf'
  | 'record'
  | 'pattern'
  | 'sequence'
  | 'gap'
  | 'nthClearer'
  | 'chase'
  | 'best'
  | 'manual'
  | 'pack'
  | 'value';
export type GrantMode =
  | 'live'
  | 'persistTier'
  | 'persistSnapshot'
  | 'resetOnGrowth'
  | 'manualLock'
  | 'chase';
export type BackfillMode = 'now' | 'forward' | 'queue';
export type ConfirmMode = 'none' | 'accuracyFull' | 'judgementsFull';
export type StatMode = 'tier' | 'credit' | 'bar' | 'barThenNumber';
export type Aggregate =
  | 'count'
  | 'countDistinct'
  | 'maxPerIdentity'
  | 'maxChartClears'
  | 'maxSongsPerArtist'
  | 'maxPerSong'
  | 'ratingWeek';
export type CreditRole = 'charter' | 'vfxer' | 'either';
export type CoverageSource = 'set' | 'references' | 'curation' | 'curationTypes' | 'expressions' | 'groups';
export type RecordMetric = 'accuracy' | 'score' | 'speed';
export type BestMetric = 'keyCount' | 'perfectCount' | 'difficultyNumber' | 'misses' | 'speed' | 'accuracy' | 'charterCount';

export type PatternMatch = {
  sharedAccuracy?: boolean;
  accuracyIncludes?: string;
  minAccuracy?: number;
  maxAccuracy?: number;
  exactAccuracy?: number;
  belowAccuracy?: number;
  purePerfect?: boolean;
  ppMinusOne?: boolean;
  minMisses?: number;
  noMisses?: boolean;
  symmetry?: boolean;
  technicallyPure?: boolean;
  noPerfects?: boolean;
  asymmetry?: boolean;
  gamma?: number;
  bucketEquals?: { bucket: JudgementKey; count: number };
  judgementPattern?: number[];
  month?: number;
  day?: number;
  levelIds?: number[];
  families?: string[];
  minSpeed?: number;
  minDurationMs?: number;
  scoreDecimals?: number;
  scoreEndsWith?: string;
  expression?: string;
};

export type SequenceParams = {
  blocks?: number[][];
  order?: number[];
  rangeSize?: number;
  excludeDifficultyNames?: string[];
  perStep?: PatternMatch;
  consecutive?: boolean;
  expression?: string;
};

export type BadgeParams = {
  aggregate?: Aggregate;
  minSpeed?: number;
  speedEquals?: number;
  worldsFirst?: boolean;
  worldsFirstPP?: boolean;
  purePerfect?: boolean;
  families?: string[];
  difficultyNames?: string[];
  difficultySet?: string;
  maxKeyCount?: number;
  minKeyCount?: number;
  useDifficultyAt?: boolean;
  requireNoPriorClear?: boolean;
  curationTypes?: string[];
  role?: CreditRole;
  sole?: boolean;
  minDurationMs?: number;
  source?: CoverageSource;
  set?: string;
  ordered?: boolean;
  prefix?: boolean;
  curationType?: string;
  types?: string[];
  roleScoped?: boolean;
  fraction?: number;
  minCharts?: number;
  family?: string;
  difficultyName?: string;
  metric?: RecordMetric | BestMetric;
  requireWorldsFirst?: boolean;
  requireHighestScore?: boolean;
  requireHighestSpeed?: boolean;
  creditFrom?: 'charts' | 'otherClears';
  minDays?: number;
  n?: number;
  excludeDifficultyNames?: string[];
  expressions?: string[];
  groups?: string[][];
  complete?: boolean;
  roleScope?: 'basic' | 'ex';
  packName?: string;
  packId?: number;
  kind?: 'pattern' | 'sequence';
  pattern?: PatternMatch;
  sequence?: SequenceParams;
  blocks?: number[][];
  order?: number[];
  rangeSize?: number;
  perStep?: PatternMatch;
  consecutive?: boolean;
  id?: number;
} & PatternMatch;

export type BadgeDisplay = {
  icon: string | null;
  color: string | null;
  stat: StatMode;
  purple: boolean;
  description: string | null;
};

export type BadgeDraft = {
  audience: Audience;
  slug: string;
  name: string;
  secret: boolean;
  enabled: boolean;
  reducer: ReducerName;
  grant: GrantMode;
  identity: IdentityMode;
  backfill: BackfillMode;
  curve: Curve;
  tierLabels: TierLabel[];
  weight: number;
  display: BadgeDisplay;
  confirm: ConfirmMode;
  params: BadgeParams;
  publishedAt: string | null;
  id?: number;
};

const REDUCERS: ReducerName[] = [
  'threshold', 'coverage', 'percentOf', 'record', 'pattern', 'sequence',
  'gap', 'nthClearer', 'chase', 'best', 'manual', 'pack', 'value',
];
const GRANTS: GrantMode[] = [
  'live', 'persistTier', 'persistSnapshot', 'resetOnGrowth', 'manualLock', 'chase',
];
const IDENTITIES: IdentityMode[] = ['level', 'chartSubgroup', 'vfxSubgroup', 'group'];
const BACKFILLS: BackfillMode[] = ['now', 'forward', 'queue'];
const CONFIRMS: ConfirmMode[] = ['none', 'accuracyFull', 'judgementsFull'];
const STATS: StatMode[] = ['tier', 'credit', 'bar', 'barThenNumber'];
const AGGREGATES: Aggregate[] = [
  'count', 'countDistinct', 'maxPerIdentity', 'maxChartClears', 'maxSongsPerArtist', 'maxPerSong', 'ratingWeek',
];

const THRESHOLD_KEYS = [
  'aggregate', 'minSpeed', 'speedEquals', 'worldsFirst', 'worldsFirstPP', 'purePerfect',
  'families', 'difficultyNames', 'difficultySet', 'maxKeyCount', 'minKeyCount',
  'useDifficultyAt', 'requireNoPriorClear', 'curationTypes', 'role', 'sole', 'minDurationMs',
  'expression',
];
const PATTERN_KEYS = [
  'sharedAccuracy', 'accuracyIncludes', 'minAccuracy', 'maxAccuracy', 'exactAccuracy',
  'belowAccuracy', 'purePerfect', 'ppMinusOne', 'minMisses', 'noMisses', 'symmetry',
  'technicallyPure', 'noPerfects', 'asymmetry', 'gamma', 'bucketEquals', 'judgementPattern',
  'month', 'day', 'levelIds', 'families', 'minSpeed', 'minDurationMs', 'scoreDecimals', 'scoreEndsWith',
  'expression',
];
const SEQUENCE_KEYS = [
  'blocks', 'order', 'rangeSize', 'excludeDifficultyNames', 'perStep', 'consecutive', 'expression',
];
const KEYS: Record<ReducerName, string[]> = {
  threshold: THRESHOLD_KEYS,
  coverage: ['source', 'set', 'ordered', 'prefix', 'curationType', 'types', 'roleScoped', 'role', 'roleScope', 'expressions', 'groups', 'complete'],
  percentOf: ['difficultyName', 'family', 'fraction', 'minCharts', 'useDifficultyAt'],
  record: [
    'metric', 'families', 'requireWorldsFirst', 'requireHighestScore', 'requireHighestSpeed',
    'creditFrom', 'expression',
  ],
  pattern: PATTERN_KEYS,
  sequence: SEQUENCE_KEYS,
  gap: ['minDays', 'expression'],
  nthClearer: ['n'],
  chase: ['excludeDifficultyNames'],
  best: ['metric', 'families', 'useDifficultyAt', 'expression', 'role'],
  manual: ['kind', 'pattern', 'sequence'],
  pack: ['packId', 'packName'],
  value: ['expression', 'packId', 'packName'],
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknown(source: Record<string, unknown>, allowed: readonly string[], errors: string[], prefix: string) {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) errors.push(`${prefix}${key} is not a parameter`);
  }
}

function readExpression(source: Record<string, unknown>, key: string, errors: string[]): string | undefined {
  const text = readString(source, key, errors);
  if (!text) return undefined;
  const parsed = parseFormula(text);
  if (!parsed.ok) errors.push(parsed.error);
  return text;
}

function readString(source: Record<string, unknown>, key: string, errors: string[]): string | undefined {
  if (source[key] == null) return undefined;
  if (typeof source[key] !== 'string' || !String(source[key]).trim()) {
    errors.push(`${key} must be text`);
    return undefined;
  }
  return String(source[key]).trim();
}

function readNumber(source: Record<string, unknown>, key: string, errors: string[]): number | undefined {
  if (source[key] == null) return undefined;
  const value = Number(source[key]);
  if (!Number.isFinite(value)) {
    errors.push(`${key} must be a number`);
    return undefined;
  }
  return value;
}

function readBool(source: Record<string, unknown>, key: string, errors: string[]): boolean | undefined {
  if (source[key] == null) return undefined;
  if (typeof source[key] !== 'boolean') {
    errors.push(`${key} must be true or false`);
    return undefined;
  }
  return source[key] as boolean;
}

function readStringList(source: Record<string, unknown>, key: string, errors: string[]): string[] | undefined {
  if (source[key] == null) return undefined;
  if (!Array.isArray(source[key]) || (source[key] as unknown[]).some((item) => typeof item !== 'string')) {
    errors.push(`${key} must be a list of text`);
    return undefined;
  }
  return (source[key] as string[]).map((item) => item.trim()).filter(Boolean);
}

function readNumberList(source: Record<string, unknown>, key: string, errors: string[]): number[] | undefined {
  if (source[key] == null) return undefined;
  if (!Array.isArray(source[key])) {
    errors.push(`${key} must be a list of numbers`);
    return undefined;
  }
  const out: number[] = [];
  for (const item of source[key] as unknown[]) {
    const value = Number(item);
    if (!Number.isInteger(value)) {
      errors.push(`${key} must be a list of integers`);
      return undefined;
    }
    out.push(value);
  }
  return out;
}

function readPattern(source: unknown, errors: string[], prefix: string): PatternMatch | undefined {
  if (source == null) return undefined;
  if (!isObject(source)) {
    errors.push(`${prefix}pattern must be an object`);
    return undefined;
  }
  rejectUnknown(source, PATTERN_KEYS, errors, prefix);
  const pattern: PatternMatch = {};
  const assign = (key: keyof PatternMatch, value: unknown) => {
    if (value !== undefined) (pattern as Record<string, unknown>)[key] = value;
  };
  assign('sharedAccuracy', readBool(source, 'sharedAccuracy', errors));
  assign('accuracyIncludes', readString(source, 'accuracyIncludes', errors));
  assign('minAccuracy', readNumber(source, 'minAccuracy', errors));
  assign('maxAccuracy', readNumber(source, 'maxAccuracy', errors));
  assign('exactAccuracy', readNumber(source, 'exactAccuracy', errors));
  assign('belowAccuracy', readNumber(source, 'belowAccuracy', errors));
  assign('purePerfect', readBool(source, 'purePerfect', errors));
  assign('ppMinusOne', readBool(source, 'ppMinusOne', errors));
  assign('minMisses', readNumber(source, 'minMisses', errors));
  assign('noMisses', readBool(source, 'noMisses', errors));
  assign('symmetry', readBool(source, 'symmetry', errors));
  assign('technicallyPure', readBool(source, 'technicallyPure', errors));
  assign('noPerfects', readBool(source, 'noPerfects', errors));
  assign('asymmetry', readBool(source, 'asymmetry', errors));
  assign('gamma', readNumber(source, 'gamma', errors));
  assign('month', readNumber(source, 'month', errors));
  assign('day', readNumber(source, 'day', errors));
  assign('levelIds', readNumberList(source, 'levelIds', errors));
  assign('families', readStringList(source, 'families', errors));
  assign('minSpeed', readNumber(source, 'minSpeed', errors));
  assign('minDurationMs', readNumber(source, 'minDurationMs', errors));
  assign('scoreDecimals', readNumber(source, 'scoreDecimals', errors));
  assign('scoreEndsWith', readString(source, 'scoreEndsWith', errors));
  assign('expression', readExpression(source, 'expression', errors));
  if (source.judgementPattern != null) {
    const row = readNumberList(source, 'judgementPattern', errors);
    if (row && row.length !== 7) errors.push('judgementPattern must have 7 integers');
    else if (row) pattern.judgementPattern = row;
  }
  if (source.bucketEquals != null) {
    if (!isObject(source.bucketEquals)) errors.push('bucketEquals must be an object');
    else {
      const bucket = String(source.bucketEquals.bucket || '');
      const count = Number(source.bucketEquals.count);
      if (!JUDGEMENT_KEYS.includes(bucket as JudgementKey) || !Number.isFinite(count)) {
        errors.push('bucketEquals needs a judgement bucket and a count');
      } else {
        pattern.bucketEquals = { bucket: bucket as JudgementKey, count };
      }
    }
  }
  return pattern;
}

function readSequence(source: unknown, errors: string[]): SequenceParams | undefined {
  if (source == null) return undefined;
  if (!isObject(source)) {
    errors.push('sequence must be an object');
    return undefined;
  }
  rejectUnknown(source, SEQUENCE_KEYS, errors, 'sequence.');
  const sequence: SequenceParams = {};
  if (source.blocks != null) {
    if (!Array.isArray(source.blocks)) errors.push('sequence.blocks must be a list of id lists');
    else {
      const blocks: number[][] = [];
      for (const block of source.blocks) {
        if (!Array.isArray(block)) {
          errors.push('sequence.blocks must be a list of id lists');
          break;
        }
        const ids = block.map((item) => Number(item));
        if (ids.some((id) => !Number.isInteger(id))) {
          errors.push('sequence.blocks must contain integers');
          break;
        }
        blocks.push(ids);
      }
      sequence.blocks = blocks;
    }
  }
  const order = readNumberList(source, 'order', errors);
  if (order) sequence.order = order;
  const rangeSize = readNumber(source, 'rangeSize', errors);
  if (rangeSize != null) sequence.rangeSize = rangeSize;
  const exclude = readStringList(source, 'excludeDifficultyNames', errors);
  if (exclude) sequence.excludeDifficultyNames = exclude;
  const perStep = readPattern(source.perStep, errors, 'sequence.perStep.');
  if (perStep) sequence.perStep = perStep;
  const consecutive = readBool(source, 'consecutive', errors);
  if (consecutive != null) sequence.consecutive = consecutive;
  const expression = readExpression(source, 'expression', errors);
  if (expression) sequence.expression = expression;
  return sequence;
}

function readParams(reducer: ReducerName, source: unknown, errors: string[]): BadgeParams {
  if (!isObject(source)) {
    errors.push('params must be an object');
    return {};
  }
  rejectUnknown(source, KEYS[reducer], errors, '');
  const params: BadgeParams = {};
  const copyNumber = (key: keyof BadgeParams) => {
    const value = readNumber(source, key, errors);
    if (value != null) (params as Record<string, unknown>)[key] = value;
  };
  const copyBool = (key: keyof BadgeParams) => {
    const value = readBool(source, key, errors);
    if (value != null) (params as Record<string, unknown>)[key] = value;
  };
  const copyStrings = (key: keyof BadgeParams) => {
    const value = readStringList(source, key, errors);
    if (value) (params as Record<string, unknown>)[key] = value;
  };
  if (reducer === 'threshold') {
    const aggregate = readString(source, 'aggregate', errors) as Aggregate | undefined;
    params.aggregate = aggregate && AGGREGATES.includes(aggregate) ? aggregate : 'countDistinct';
    if (aggregate && !AGGREGATES.includes(aggregate)) errors.push('aggregate is not recognized');
    copyNumber('minSpeed');
    copyNumber('speedEquals');
    copyBool('worldsFirst');
    copyBool('worldsFirstPP');
    copyBool('purePerfect');
    copyBool('useDifficultyAt');
    copyBool('requireNoPriorClear');
    copyBool('sole');
    copyNumber('maxKeyCount');
    copyNumber('minKeyCount');
    copyNumber('minDurationMs');
    copyStrings('families');
    copyStrings('difficultyNames');
    copyStrings('curationTypes');
    const difficultySet = readString(source, 'difficultySet', errors);
    if (difficultySet) params.difficultySet = difficultySet;
    const expression = readExpression(source, 'expression', errors);
    if (expression) params.expression = expression;
    const role = readString(source, 'role', errors);
    if (role) {
      if (role !== 'charter' && role !== 'vfxer' && role !== 'either') errors.push('role is not recognized');
      else params.role = role;
    }
  }
  if (reducer === 'coverage') {
    const sourceName = readString(source, 'source', errors);
    if (!sourceName || !['set', 'references', 'curation', 'curationTypes', 'expressions', 'groups'].includes(sourceName)) {
      errors.push('source must be set, references, curation, curationTypes, expressions, or groups');
    } else params.source = sourceName as CoverageSource;
    const set = readString(source, 'set', errors);
    if (set) params.set = set;
    const curationType = readString(source, 'curationType', errors);
    if (curationType) params.curationType = curationType;
    copyBool('ordered');
    copyBool('prefix');
    copyBool('roleScoped');
    copyStrings('types');
    const role = readString(source, 'role', errors);
    if (role === 'charter' || role === 'vfxer' || role === 'either') params.role = role;
    copyBool('complete');
    const roleScope = readString(source, 'roleScope', errors);
    if (roleScope === 'basic' || roleScope === 'ex') params.roleScope = roleScope;
    else if (roleScope) errors.push('roleScope must be basic or ex');
    if (Array.isArray(source.expressions)) {
      const expressions = source.expressions.map((item) => String(item));
      for (const expression of expressions) {
        const parsed = parseFormula(expression);
        if (!parsed.ok) errors.push(parsed.error);
      }
      params.expressions = expressions;
    }
    if (Array.isArray(source.groups)) {
      const groups = source.groups.map((group) => Array.isArray(group) ? group.map((item) => String(item)) : []);
      for (const group of groups) {
        for (const expression of group) {
          const parsed = parseFormula(expression);
          if (!parsed.ok) errors.push(parsed.error);
        }
      }
      params.groups = groups;
    }
  }
  if (reducer === 'percentOf') {
    const fraction = readNumber(source, 'fraction', errors);
    if (fraction == null || fraction <= 0 || fraction > 1) errors.push('fraction must be between 0 and 1');
    else params.fraction = fraction;
    params.minCharts = readNumber(source, 'minCharts', errors) ?? 0;
    const difficultyName = readString(source, 'difficultyName', errors);
    if (difficultyName) params.difficultyName = difficultyName;
    const family = readString(source, 'family', errors);
    if (family) params.family = family;
    copyBool('useDifficultyAt');
  }
  if (reducer === 'record') {
    const metric = readString(source, 'metric', errors);
    if (metric !== 'accuracy' && metric !== 'score' && metric !== 'speed') errors.push('metric must be accuracy, score, or speed');
    else params.metric = metric;
    copyStrings('families');
    copyBool('requireWorldsFirst');
    copyBool('requireHighestScore');
    copyBool('requireHighestSpeed');
    const creditFrom = readString(source, 'creditFrom', errors);
    if (creditFrom) {
      if (creditFrom !== 'charts' && creditFrom !== 'otherClears') errors.push('creditFrom is not recognized');
      else params.creditFrom = creditFrom;
    }
    const expression = readExpression(source, 'expression', errors);
    if (expression) params.expression = expression;
  }
  if (reducer === 'pattern') Object.assign(params, readPattern(source, errors, ''));
  if (reducer === 'sequence') Object.assign(params, readSequence(source, errors));
  if (reducer === 'gap') {
    const minDays = readNumber(source, 'minDays', errors);
    if (minDays != null) params.minDays = minDays;
    const expression = readExpression(source, 'expression', errors);
    if (expression) params.expression = expression;
  }
  if (reducer === 'nthClearer') {
    const n = readNumber(source, 'n', errors);
    if (n == null || !Number.isInteger(n) || n < 1) errors.push('n must be an integer of at least 1');
    else params.n = n;
  }
  if (reducer === 'chase') copyStrings('excludeDifficultyNames');
  if (reducer === 'best') {
    const metric = readString(source, 'metric', errors);
    const allowed = ['keyCount', 'perfectCount', 'difficultyNumber', 'misses', 'speed', 'accuracy', 'charterCount'];
    if (!metric || !allowed.includes(metric)) errors.push('metric is not recognized');
    else params.metric = metric as BestMetric;
    copyStrings('families');
    copyBool('useDifficultyAt');
    const expression = readExpression(source, 'expression', errors);
    if (expression) params.expression = expression;
    const role = readString(source, 'role', errors);
    if (role === 'charter' || role === 'vfxer' || role === 'either') params.role = role;
    else if (role) errors.push('role is not recognized');
  }
  if (reducer === 'manual') {
    const kind = readString(source, 'kind', errors);
    if (kind !== 'pattern' && kind !== 'sequence') errors.push('kind must be pattern or sequence');
    else params.kind = kind;
    params.pattern = readPattern(source.pattern, errors, 'pattern.');
    params.sequence = readSequence(source.sequence, errors);
  }
  if (reducer === 'pack') {
    const packId = readNumber(source, 'packId', errors);
    const packName = readString(source, 'packName', errors);
    if ((packId == null || !Number.isInteger(packId) || packId <= 0) && !packName) {
      errors.push('pack needs a packId or packName');
    }
    if (packId != null && Number.isInteger(packId) && packId > 0) params.packId = packId;
    if (packName) params.packName = packName;
  }
  if (reducer === 'value') {
    const expression = readString(source, 'expression', errors);
    if (!expression) errors.push('expression is required');
    else {
      const parsed = parseValueExpr(expression);
      if (!parsed.ok) errors.push(parsed.error);
      else params.expression = expression;
    }
    const packId = readNumber(source, 'packId', errors);
    const packName = readString(source, 'packName', errors);
    if (packId != null && Number.isInteger(packId) && packId > 0) params.packId = packId;
    if (packName) params.packName = packName;
  }
  return params;
}

function readCurve(source: unknown, errors: string[]): Curve {
  const fallback: Curve = { start: 1, step: 0.5, round: 'none', direction: 'up' };
  if (source == null) return fallback;
  if (!isObject(source)) {
    errors.push('curve must be an object');
    return fallback;
  }
  rejectUnknown(source, ['start', 'step', 'round', 'direction'], errors, 'curve.');
  const start = readNumber(source, 'start', errors);
  const step = readNumber(source, 'step', errors);
  const round = readString(source, 'round', errors);
  const direction = readString(source, 'direction', errors);
  if (round && round !== 'none' && round !== 'ceil') errors.push('curve.round must be none or ceil');
  if (direction && direction !== 'up' && direction !== 'down') errors.push('curve.direction must be up or down');
  return {
    start: start ?? 1,
    step: step ?? 0.5,
    round: round === 'ceil' ? 'ceil' : 'none',
    direction: direction === 'down' ? 'down' : 'up',
  };
}

function readLabels(source: unknown, errors: string[]): TierLabel[] {
  if (source == null) return [];
  if (!Array.isArray(source)) {
    errors.push('tierLabels must be a list');
    return [];
  }
  const out: TierLabel[] = [];
  for (const row of source) {
    if (!isObject(row)) {
      errors.push('tierLabels entries must be objects');
      continue;
    }
    const minTier = Number(row.minTier);
    const label = typeof row.label === 'string' ? row.label.trim() : '';
    if (!Number.isInteger(minTier) || minTier < 1 || !label || label.length > 40) {
      errors.push('tierLabels need a minTier of at least 1 and a short label');
      continue;
    }
    out.push({ minTier, label });
  }
  return out;
}

function readDisplay(source: unknown, errors: string[]): BadgeDraft['display'] {
  const fallback: BadgeDraft['display'] = { icon: null, color: null, stat: 'barThenNumber', purple: false, description: null };
  if (source == null) return fallback;
  if (!isObject(source)) {
    errors.push('display must be an object');
    return fallback;
  }
  rejectUnknown(source, ['icon', 'color', 'stat', 'purple', 'description'], errors, 'display.');
  const stat = readString(source, 'stat', errors);
  if (stat && !STATS.includes(stat as StatMode)) errors.push('display.stat is not recognized');
  const description = typeof source.description === 'string' ? source.description.trim().slice(0, 180) : '';
  return {
    icon: typeof source.icon === 'string' ? source.icon.slice(0, 200) : null,
    color: typeof source.color === 'string' ? source.color.slice(0, 32) : null,
    stat: stat && STATS.includes(stat as StatMode) ? stat as StatMode : 'barThenNumber',
    purple: source.purple === true,
    description: description || null,
  };
}

export function normalizeDefinition(input: unknown): { ok: true; value: BadgeDraft } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ['definition must be an object'] };
  const audience = readString(input, 'audience', errors);
  const slug = readString(input, 'slug', errors);
  const name = readString(input, 'name', errors);
  const reducer = readString(input, 'reducer', errors);
  const grant = readString(input, 'grant', errors);
  const identity = readString(input, 'identity', errors);
  const backfill = readString(input, 'backfill', errors) || 'forward';
  const confirm = readString(input, 'confirm', errors) ?? 'none';
  if (audience !== 'player' && audience !== 'creator') errors.push('audience must be player or creator');
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64) {
    errors.push('slug must be lowercase letters, numbers, and dashes');
  }
  if (!name || name.length > 80) errors.push('name must be 1 to 80 characters');
  if (!reducer || !REDUCERS.includes(reducer as ReducerName)) errors.push('reducer is not recognized');
  if (!grant || !GRANTS.includes(grant as GrantMode)) errors.push('grant is not recognized');
  if (!identity || !IDENTITIES.includes(identity as IdentityMode)) errors.push('identity is not recognized');
  if (!backfill || !BACKFILLS.includes(backfill as BackfillMode)) errors.push('backfill is not recognized');
  if (!CONFIRMS.includes(confirm as ConfirmMode)) errors.push('confirm is not recognized');
  const weight = readNumber(input, 'weight', errors);
  const curve = readCurve(input.curve, errors);
  const tierLabels = readLabels(input.tierLabels, errors);
  const display = readDisplay(input.display, errors);
  const params = reducer && REDUCERS.includes(reducer as ReducerName)
    ? readParams(reducer as ReducerName, input.params ?? {}, errors)
    : {};
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      audience: audience as Audience,
      slug: slug as string,
      name: name as string,
      secret: input.secret === true,
      enabled: input.enabled !== false,
      reducer: reducer as ReducerName,
      grant: grant as GrantMode,
      identity: identity as IdentityMode,
      backfill: backfill as BackfillMode,
      curve,
      tierLabels,
      weight: weight ?? 1,
      display,
      confirm: confirm as ConfirmMode,
      params,
      publishedAt: typeof input.publishedAt === 'string' ? input.publishedAt : null,
    },
  };
}
