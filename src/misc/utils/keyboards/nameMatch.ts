export function nfkcFold(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

export type NamedPlayer = {
  id: number;
  name: string;
  aliases: string[];
};

export type RankerNameMatch = {
  playerId: number;
} | {
  status: 'none' | 'ambiguous';
  names: string[];
};

export function matchRankerToPlayer(
  names: Array<string | null | undefined>,
  players: NamedPlayer[],
): RankerNameMatch {
  const wanted = [...new Set(names.filter((name): name is string => Boolean(name && name.trim())).map(nfkcFold))];
  if (!wanted.length) return {status: 'none', names: []};

  const hits = new Map<number, string>();
  for (const player of players) {
    const pool = [player.name, ...player.aliases].map(nfkcFold);
    for (const name of wanted) {
      if (pool.includes(name)) {
        hits.set(player.id, player.name);
        break;
      }
    }
  }

  if (hits.size === 1) {
    return {playerId: [...hits.keys()][0]};
  }
  if (hits.size === 0) {
    return {status: 'none', names: wanted};
  }
  return {status: 'ambiguous', names: [...hits.values()]};
}
