import Level from '@/models/levels/Level.js';
import Pass from '@/models/passes/Pass.js';
import Player from '@/models/players/Player.js';
import Creator from '@/models/credits/Creator.js';
import client, {
  levelIndexName,
  passIndexName,
  playerIndexName,
  creatorIndexName,
} from '@/config/elasticsearch.js';

async function esCount(index: string): Promise<number> {
  const res = await client.count({ index });
  return typeof res.count === 'number' ? res.count : Number(res.count);
}

export type ElasticsearchReconcileRow = { name: string; db: number; es: number };

/**
 * Compares MySQL row counts with Elasticsearch document counts for core indices.
 */
export async function reconcileElasticsearchCounts(): Promise<{
  rows: ElasticsearchReconcileRow[];
  drift: ElasticsearchReconcileRow[];
  ok: boolean;
}> {
  const [levelsDb, passesDb, playersDb, creatorsDb] = await Promise.all([
    Level.count(),
    Pass.count(),
    Player.count(),
    Creator.count(),
  ]);

  const [levelsEs, passesEs, playersEs, creatorsEs] = await Promise.all([
    esCount(levelIndexName),
    esCount(passIndexName),
    esCount(playerIndexName),
    esCount(creatorIndexName),
  ]);

  const rows: ElasticsearchReconcileRow[] = [
    { name: 'levels', db: levelsDb, es: levelsEs },
    { name: 'passes', db: passesDb, es: passesEs },
    { name: 'players', db: playersDb, es: playersEs },
    { name: 'creators', db: creatorsDb, es: creatorsEs },
  ];

  const drift = rows.filter((r) => r.db !== r.es);
  return { rows, drift, ok: drift.length === 0 };
}
