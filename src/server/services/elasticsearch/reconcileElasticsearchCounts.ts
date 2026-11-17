import Level from '@/models/levels/Level.js';
import Pass from '@/models/passes/Pass.js';
import Player from '@/models/players/Player.js';
import Creator from '@/models/credits/Creator.js';
import Mod from '@/models/misc/Mod.js';
import Tournament from '@/models/tournaments/Tournament.js';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import { PassSubmission } from '@/models/submissions/PassSubmission.js';
import client, {
  levelIndexName,
  passIndexName,
  playerIndexName,
  creatorIndexName,
  modIndexName,
  tournamentIndexName,
  submissionQueueIndexName,
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
  const [levelsDb, passesDb, playersDb, creatorsDb, modsDb, tournamentsDb, pendingLevelsDb, pendingPassesDb] = await Promise.all([
    Level.count(),
    Pass.count(),
    Player.count(),
    Creator.count(),
    Mod.count(),
    Tournament.count(),
    LevelSubmission.count({ where: { status: 'pending' } }),
    PassSubmission.count({ where: { status: 'pending' } }),
  ]);

  const [levelsEs, passesEs, playersEs, creatorsEs, modsEs, tournamentsEs, submissionsEs] = await Promise.all([
    esCount(levelIndexName),
    esCount(passIndexName),
    esCount(playerIndexName),
    esCount(creatorIndexName),
    esCount(modIndexName),
    esCount(tournamentIndexName),
    esCount(submissionQueueIndexName),
  ]);

  const rows: ElasticsearchReconcileRow[] = [
    { name: 'levels', db: levelsDb, es: levelsEs },
    { name: 'passes', db: passesDb, es: passesEs },
    { name: 'players', db: playersDb, es: playersEs },
    { name: 'creators', db: creatorsDb, es: creatorsEs },
    { name: 'mods', db: modsDb, es: modsEs },
    { name: 'tournaments', db: tournamentsDb, es: tournamentsEs },
    { name: 'submissions', db: pendingLevelsDb + pendingPassesDb, es: submissionsEs },
  ];

  const drift = rows.filter((r) => r.db !== r.es);
  return { rows, drift, ok: drift.length === 0 };
}
