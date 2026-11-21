import { identityKey, type IdentityMode, type LinkInfo } from './identity.js';
import { throwIfBadgeCancelled } from '../jobs/cancelSignal.js';

export type CoverageChart = {
  id: number;
  diffName: string;
};

export type DifficultyCount = {
  total: number;
  cleared: number;
  ratio: number | null;
};

export type DifficultyBucket = {
  name: string;
  total: number;
  levelIds: number[];
  identitySet: Set<string>;
};

export type DifficultyCoverageTable = {
  mode: IdentityMode;
  identityByLevel: Map<number, string>;
  byName: Map<string, DifficultyBucket>;
};

export type OwnerDifficultyCounts = Partial<Record<IdentityMode, Record<string, DifficultyCount>>>;

const emptyCount: DifficultyCount = { total: 0, cleared: 0, ratio: null };

const catalogTables = new WeakMap<CoverageChart[], {
  links: Record<number, LinkInfo>;
  byMode: Map<IdentityMode, DifficultyCoverageTable>;
}>();

const ownerCountCache = new WeakMap<object, {
  charts: CoverageChart[];
  links: Record<number, LinkInfo>;
  byMode: Map<IdentityMode, Record<string, DifficultyCount>>;
}>();

export function catalogDifficultyCoverage(
  charts: CoverageChart[],
  links: Record<number, LinkInfo>,
  mode: IdentityMode,
): DifficultyCoverageTable {
  let entry = catalogTables.get(charts);
  if (!entry || entry.links !== links) {
    entry = { links, byMode: new Map() };
    catalogTables.set(charts, entry);
  }
  const cached = entry.byMode.get(mode);
  if (cached) return cached;
  const identityByLevel = new Map<number, string>();
  const byName = new Map<string, DifficultyBucket>();
  for (const chart of charts) {
    throwIfBadgeCancelled();
    const identity = identityKey(mode, chart.id, links[chart.id] ?? null);
    identityByLevel.set(chart.id, identity);
    let bucket = byName.get(chart.diffName);
    if (!bucket) {
      bucket = { name: chart.diffName, total: 0, levelIds: [], identitySet: new Set() };
      byName.set(chart.diffName, bucket);
    }
    bucket.levelIds.push(chart.id);
    bucket.identitySet.add(identity);
  }
  for (const bucket of byName.values()) bucket.total = bucket.identitySet.size;
  const table: DifficultyCoverageTable = { mode, identityByLevel, byName };
  entry.byMode.set(mode, table);
  return table;
}

export function identitiesFromPasses(
  table: DifficultyCoverageTable,
  links: Record<number, LinkInfo>,
  passes: { levelId: number }[],
): Set<string> {
  const identities = new Set<string>();
  for (const pass of passes) {
    throwIfBadgeCancelled();
    identities.add(
      table.identityByLevel.get(pass.levelId)
      ?? identityKey(table.mode, pass.levelId, links[pass.levelId] ?? null),
    );
  }
  return identities;
}

export function ownerDifficultyCounts(
  table: DifficultyCoverageTable,
  ownerIdentities: Set<string>,
): Record<string, DifficultyCount> {
  const counts: Record<string, DifficultyCount> = Object.create(null);
  for (const [name, bucket] of table.byName) {
    throwIfBadgeCancelled();
    let cleared = 0;
    for (const identity of bucket.identitySet) {
      if (ownerIdentities.has(identity)) cleared += 1;
    }
    counts[name] = {
      total: bucket.total,
      cleared,
      ratio: bucket.total > 0 ? cleared / bucket.total : null,
    };
  }
  return counts;
}

export function cachedOwnerDifficultyCounts(
  charts: CoverageChart[],
  links: Record<number, LinkInfo>,
  mode: IdentityMode,
  passes: { levelId: number }[],
): Record<string, DifficultyCount> {
  let entry = ownerCountCache.get(passes);
  if (!entry || entry.charts !== charts || entry.links !== links) {
    entry = { charts, links, byMode: new Map() };
    ownerCountCache.set(passes, entry);
  }
  const cached = entry.byMode.get(mode);
  if (cached) return cached;
  const table = catalogDifficultyCoverage(charts, links, mode);
  const counts = ownerDifficultyCounts(table, identitiesFromPasses(table, links, passes));
  entry.byMode.set(mode, counts);
  return counts;
}

export function frozenDifficultyCount(
  table: DifficultyCoverageTable,
  name: string,
  frozenIds: ReadonlySet<number>,
  ownerIdentities: Set<string>,
): { count: DifficultyCount; levelIds: number[] } {
  const bucket = table.byName.get(name);
  if (!bucket) return { count: emptyCount, levelIds: [] };
  const identities = new Set<string>();
  const levelIds: number[] = [];
  for (const id of bucket.levelIds) {
    throwIfBadgeCancelled();
    if (!frozenIds.has(id)) continue;
    levelIds.push(id);
    const identity = table.identityByLevel.get(id);
    if (identity) identities.add(identity);
  }
  let cleared = 0;
  for (const identity of identities) {
    if (ownerIdentities.has(identity)) cleared += 1;
  }
  return {
    count: {
      total: identities.size,
      cleared,
      ratio: identities.size > 0 ? cleared / identities.size : null,
    },
    levelIds,
  };
}

export function lookupDifficultyCount(
  counts: Record<string, DifficultyCount> | undefined,
  name: string,
): DifficultyCount {
  return counts?.[name] ?? emptyCount;
}

export function identityModesForDifficultyBadges(
  defs: { reducer: string; identity: IdentityMode; params?: { expression?: string } }[],
): IdentityMode[] {
  const modes = new Set<IdentityMode>();
  for (const def of defs) {
    if (def.reducer !== 'value') continue;
    if (!/\bdifficulty\s*\(/.test(def.params?.expression || '')) continue;
    modes.add(def.identity);
  }
  return [...modes];
}

export function prepareOwnerDifficultyCounts(
  charts: CoverageChart[],
  links: Record<number, LinkInfo>,
  passes: { levelId: number }[],
  modes: IdentityMode[],
): OwnerDifficultyCounts {
  const prepared: OwnerDifficultyCounts = {};
  for (const mode of modes) {
    prepared[mode] = cachedOwnerDifficultyCounts(charts, links, mode, passes);
  }
  return prepared;
}
