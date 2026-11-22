export type BadgeDirt = {
  players: number[];
  creators: number[];
  levels: number[];
  packs: number[];
  catalog: boolean;
};

export type BadgeDirtPatch = {
  players?: number[];
  creators?: number[];
  levels?: number[];
  packs?: number[];
  catalog?: boolean;
};

function uniqueIds(values: Iterable<number>): number[] {
  const ids = new Set<number>();
  for (const value of values) {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return [...ids].sort((left, right) => left - right);
}

export function emptyDirt(): BadgeDirt {
  return { players: [], creators: [], levels: [], packs: [], catalog: false };
}

export function parseDirt(raw: unknown): BadgeDirt {
  const empty = emptyDirt();
  if (raw == null) return empty;
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return empty;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  const row = value as BadgeDirtPatch;
  return {
    players: uniqueIds(row.players ?? []),
    creators: uniqueIds(row.creators ?? []),
    levels: uniqueIds(row.levels ?? []),
    packs: uniqueIds(row.packs ?? []),
    catalog: Boolean(row.catalog),
  };
}

export function mergeDirt(base: BadgeDirt, patch: BadgeDirtPatch): BadgeDirt {
  return {
    players: uniqueIds([...base.players, ...(patch.players ?? [])]),
    creators: uniqueIds([...base.creators, ...(patch.creators ?? [])]),
    levels: uniqueIds([...base.levels, ...(patch.levels ?? [])]),
    packs: uniqueIds([...base.packs, ...(patch.packs ?? [])]),
    catalog: Boolean(base.catalog || patch.catalog),
  };
}

export function dirtIsEmpty(dirt: BadgeDirt): boolean {
  return !dirt.catalog
    && dirt.players.length === 0
    && dirt.creators.length === 0
    && dirt.levels.length === 0
    && dirt.packs.length === 0;
}

export function planDirtEnqueue(hasBlockingAll: boolean, pendingDirty: boolean): 'drop' | 'merge' | 'insert' {
  if (hasBlockingAll) return 'drop';
  return pendingDirty ? 'merge' : 'insert';
}

export function dirtSummary(dirt: BadgeDirt): string {
  const parts: string[] = [];
  if (dirt.players.length) parts.push(`${dirt.players.length}p`);
  if (dirt.creators.length) parts.push(`${dirt.creators.length}c`);
  if (dirt.levels.length) parts.push(`${dirt.levels.length}lv`);
  if (dirt.packs.length) parts.push(`${dirt.packs.length}pk`);
  if (dirt.catalog) parts.push('cat');
  return parts.join(' ') || 'empty';
}
