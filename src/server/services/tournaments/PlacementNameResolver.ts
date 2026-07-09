import Player from '@/models/players/Player.js';
import PlayerAlias from '@/models/players/PlayerAlias.js';

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Build lookup maps for exact (case-insensitive, trimmed) player name resolution.
 * Primary names win over aliases when both exist.
 */
export async function buildNameLookupMaps(): Promise<Map<string, number>> {
  const map = new Map<string, number>();

  const players = await Player.findAll({attributes: ['id', 'name']});
  for (const p of players) {
    map.set(normalizeName(p.name), p.id);
  }
  const aliases = await PlayerAlias.findAll({attributes: ['playerId', 'name']});
  for (const a of aliases) {
    const key = normalizeName(a.name);
    if (!map.has(key)) map.set(key, a.playerId);
  }
  return map;
}

export function lookupNameId(
  map: Map<string, number>,
  displayName: string,
): number | null {
  const name = displayName.trim();
  if (!name || name === '?') return null;
  return map.get(normalizeName(name)) ?? null;
}

/**
 * Exact (case-insensitive, trimmed) player name resolution against primary names and aliases.
 * Does not fuzzy-match.
 */
export async function resolvePlacementName(
  displayName: string,
): Promise<{playerId: number | null; creatorId: number | null}> {
  const map = await buildNameLookupMaps();
  const id = lookupNameId(map, displayName);
  return {playerId: id, creatorId: null};
}
