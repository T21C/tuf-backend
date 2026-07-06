import Player from '@/models/players/Player.js';
import PlayerAlias from '@/models/players/PlayerAlias.js';
import Creator from '@/models/credits/Creator.js';
import {CreatorAlias} from '@/models/credits/CreatorAlias.js';
import type {TournamentTrack} from '@/models/tournaments/Tournament.js';

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Build lookup maps for exact (case-insensitive, trimmed) name resolution.
 * Primary names win over aliases when both exist.
 */
export async function buildNameLookupMaps(track: TournamentTrack): Promise<Map<string, number>> {
  const map = new Map<string, number>();

  if (track === 'player') {
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

  const creators = await Creator.findAll({attributes: ['id', 'name']});
  for (const c of creators) {
    map.set(normalizeName(c.name), c.id);
  }
  const aliases = await CreatorAlias.findAll({attributes: ['creatorId', 'name']});
  for (const a of aliases) {
    const key = normalizeName(a.name);
    if (!map.has(key)) map.set(key, a.creatorId);
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
 * Exact (case-insensitive, trimmed) name resolution against primary names and aliases.
 * Does not fuzzy-match.
 */
export async function resolvePlacementName(
  displayName: string,
  track: TournamentTrack,
): Promise<{playerId: number | null; creatorId: number | null}> {
  const map = await buildNameLookupMaps(track);
  const id = lookupNameId(map, displayName);
  if (track === 'player') {
    return {playerId: id, creatorId: null};
  }
  return {playerId: null, creatorId: id};
}
