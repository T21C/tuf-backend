import { QueryTypes } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { difficultyAt, isUnknownUploadTime } from '../engine/difficultyAt.js';
import { coerceJudgements, isAncientPlaceholder, type JudgementBuckets } from '../engine/judgement.js';
import type { LinkInfo } from '../engine/identity.js';
import type { BadgeSetValues, ChartFact, PassFact, WorldPass } from '../engine/evaluate.js';

type Sql = Record<string, unknown>;

async function rows<T extends Sql>(sql: string, replacements?: Record<string, unknown>): Promise<T[]> {
  const sequelize = getSequelizeForModelGroup('passes');
  return sequelize.query(sql, { replacements, type: QueryTypes.SELECT }) as Promise<T[]>;
}

function num(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ids(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0);
}

export type BadgeCatalog = {
  charts: ChartFact[];
  links: Record<number, LinkInfo>;
  sets: Record<string, BadgeSetValues>;
  packLevels: Record<number, number[]>;
  passes: PassFact[];
  world: WorldPass[];
  reviews: { definitionId: number; passId: number; status: 'pending' | 'approved' | 'rejected' }[];
  ratingsByUser: Record<string, { levelId: number; createdAt: string }[]>;
  playerUsers: Record<number, string>;
  creatorUsers: Record<number, string>;
};

export async function loadBadgeCatalog(options: {
  playerIds?: number[];
  needWorld: boolean;
}): Promise<BadgeCatalog> {
  const [difficulties, charts, credits, curations, references, links, artists, history, packs, sets] = await Promise.all([
    rows<{ id: number; name: string }>('SELECT id, name FROM difficulties'),
    rows<{
      id: number; diffId: number; diffName: string; songId: number | null; song: string | null;
      levelLengthInMs: number | null; clears: number;
    }>(`
      SELECT l.id, l.diffId, d.name AS diffName, l.songId, l.song, l.levelLengthInMs, l.clears
      FROM levels l
      INNER JOIN difficulties d ON d.id = l.diffId
      WHERE l.isDeleted = 0 AND l.isHidden = 0
    `),
    rows<{ levelId: number; creatorId: number; role: string }>(`
      SELECT levelId, creatorId, role FROM level_credits WHERE role IN ('charter', 'vfxer')
    `),
    rows<{ levelId: number; name: string; isDuplicate: number }>(`
      SELECT c.levelId, ct.name, IFNULL(c.isDuplicate, 0) AS isDuplicate
      FROM curations c
      INNER JOIN curation_curation_types j ON j.curationId = c.id
      INNER JOIN curation_types ct ON ct.id = j.typeId
    `),
    rows<{ levelId: number }>('SELECT DISTINCT levelId FROM `references`'),
    rows<{ levelId: number; groupId: number; chartSubgroup: number | null; vfxSubgroup: number | null }>(`
      SELECT levelId, groupId, chartSubgroup, vfxSubgroup FROM level_link_members
    `),
    rows<{ songId: number; artistId: number }>('SELECT songId, artistId FROM song_credits'),
    rows<{ levelId: number; previousDiffId: number | null; newDiffId: number | null; createdAt: Date }>(`
      SELECT levelId, previousDiffId, newDiffId, createdAt
      FROM level_rerate_histories
      ORDER BY levelId, createdAt
    `),
    rows<{ packId: number; levelId: number }>(`
      SELECT packId, levelId FROM level_pack_items
      WHERE type = 'level' AND levelId IS NOT NULL
    `),
    rows<{ name: string; kind: string; values: unknown }>('SELECT name, kind, `values` FROM badge_sets'),
  ]);

  const names = new Map(difficulties.map((row) => [Number(row.id), row.name]));
  const artistsBySong = new Map<number, number[]>();
  for (const row of artists) {
    const list = artistsBySong.get(Number(row.songId)) ?? [];
    list.push(Number(row.artistId));
    artistsBySong.set(Number(row.songId), list);
  }
  const charters = new Map<number, number[]>();
  const vfxers = new Map<number, number[]>();
  for (const row of credits) {
    const bucket = row.role === 'vfxer' ? vfxers : charters;
    const list = bucket.get(Number(row.levelId)) ?? [];
    list.push(Number(row.creatorId));
    bucket.set(Number(row.levelId), list);
  }
  const curationNames = new Map<number, string[]>();
  const curationCounts = new Map<number, boolean>();
  for (const row of curations) {
    const list = curationNames.get(Number(row.levelId)) ?? [];
    list.push(row.name);
    curationNames.set(Number(row.levelId), list);
    if (Number(row.isDuplicate) === 0) curationCounts.set(Number(row.levelId), true);
  }
  const referenceIds = new Set(references.map((row) => Number(row.levelId)));
  const linkMap: Record<number, LinkInfo> = {};
  for (const row of links) {
    linkMap[Number(row.levelId)] = {
      groupId: Number(row.groupId),
      chartSubgroup: row.chartSubgroup == null ? null : Number(row.chartSubgroup),
      vfxSubgroup: row.vfxSubgroup == null ? null : Number(row.vfxSubgroup),
    };
  }
  const historyByLevel = new Map<number, { createdAt: string; previousDiffId: number | null; newDiffId: number | null }[]>();
  for (const row of history) {
    const list = historyByLevel.get(Number(row.levelId)) ?? [];
    list.push({
      createdAt: new Date(row.createdAt).toISOString(),
      previousDiffId: num(row.previousDiffId),
      newDiffId: num(row.newDiffId),
    });
    historyByLevel.set(Number(row.levelId), list);
  }

  const chartFacts: ChartFact[] = charts.map((row) => ({
    id: Number(row.id),
    diffName: row.diffName,
    songId: num(row.songId),
    song: row.song ?? null,
    artistIds: artistsBySong.get(Number(row.songId)) ?? [],
    durationMs: num(row.levelLengthInMs),
    curationNames: curationNames.get(Number(row.id)) ?? [],
    charterIds: charters.get(Number(row.id)) ?? [],
    vfxerIds: vfxers.get(Number(row.id)) ?? [],
    clears: Number(row.clears) || 0,
    isReference: referenceIds.has(Number(row.id)),
    curationCounts: curationCounts.get(Number(row.id)) !== false && (curationNames.get(Number(row.id))?.length ?? 0) >= 0
      ? curationCounts.get(Number(row.id)) !== false
      : true,
  }));
  for (const chart of chartFacts) {
    if (!curationNames.has(chart.id)) chart.curationCounts = true;
    else chart.curationCounts = curationCounts.get(chart.id) === true;
  }

  const playerFilter = !options.needWorld && options.playerIds?.length ? 'AND p.playerId IN (:playerIds)' : '';
  const passRows = await rows<{
    id: number; playerId: number; levelId: number; diffNowId: number; speed: number | null; keyCount: number | null;
    vidUploadTime: Date | null; createdAt: Date; accuracy: number | null; scoreV2: number | null;
    isWorldsFirst: number | null; isWorldsFirstPP: number | null; isXPerfectMode: number | null;
    earlyDouble: number | null; earlySingle: number | null; ePerfect: number | null;
    perfectMinus: number | null; perfect: number | null; perfectPlus: number | null;
    lPerfect: number | null; lateSingle: number | null; lateDouble: number | null;
    diffNowName: string; levelLengthInMs: number | null; snapDiffId: number | null;
  }>(`
    SELECT p.id, p.playerId, p.levelId, l.diffId AS diffNowId, p.speed, p.keyCount, p.vidUploadTime, p.createdAt,
      p.accuracy, p.scoreV2, p.isWorldsFirst, p.isWorldsFirstPP, p.isXPerfectMode,
      j.earlyDouble, j.earlySingle, j.ePerfect, j.perfectMinus, j.perfect, j.perfectPlus,
      j.lPerfect, j.lateSingle, j.lateDouble,
      d.name AS diffNowName, l.levelLengthInMs, s.diffId AS snapDiffId
    FROM passes p
    INNER JOIN levels l ON l.id = p.levelId AND l.isDeleted = 0 AND l.isHidden = 0
    INNER JOIN difficulties d ON d.id = l.diffId
    LEFT JOIN judgements j ON j.id = p.id
    LEFT JOIN pass_badge_snapshots s ON s.passId = p.id
    WHERE IFNULL(p.isDeleted, 0) = 0 AND IFNULL(p.isHidden, 0) = 0
    ${playerFilter}
  `, playerFilter ? { playerIds: options.playerIds } : undefined);

  const chartById = new Map(chartFacts.map((chart) => [chart.id, chart]));
  const passFacts: PassFact[] = passRows.map((row) => {
    const judgements = coerceJudgements({
      earlyDouble: Number(row.earlyDouble ?? 0),
      earlySingle: Number(row.earlySingle ?? 0),
      ePerfect: Number(row.ePerfect ?? 0),
      perfectMinus: Number(row.perfectMinus ?? 0),
      perfect: Number(row.perfect ?? 0),
      perfectPlus: Number(row.perfectPlus ?? 0),
      lPerfect: Number(row.lPerfect ?? 0),
      lateSingle: Number(row.lateSingle ?? 0),
      lateDouble: Number(row.lateDouble ?? 0),
    } satisfies JudgementBuckets);
    const levelId = Number(row.levelId);
    const chart = chartById.get(levelId);
    const resolved = difficultyAt({
      vidUploadTime: row.vidUploadTime ? new Date(row.vidUploadTime).toISOString() : null,
      history: historyByLevel.get(levelId) ?? [],
      snapshotDiffId: num(row.snapDiffId),
      currentDiffId: Number(row.diffNowId) || 0,
    });
    const atName = names.get(resolved.diffId) ?? row.diffNowName;
    return {
      id: Number(row.id),
      playerId: Number(row.playerId),
      levelId,
      speed: num(row.speed),
      keyCount: num(row.keyCount),
      vidUploadTime: row.vidUploadTime ? new Date(row.vidUploadTime).toISOString() : null,
      uploadTimeKnown: !isUnknownUploadTime(row.vidUploadTime),
      createdAt: new Date(row.createdAt).toISOString(),
      accuracy: num(row.accuracy),
      scoreV2: num(row.scoreV2),
      isWorldsFirst: Number(row.isWorldsFirst) === 1,
      isWorldsFirstPP: Number(row.isWorldsFirstPP) === 1,
      isXPerfectMode: Number(row.isXPerfectMode) === 1,
      ancient: isAncientPlaceholder(judgements),
      judgements,
      difficultyAtName: atName,
      difficultyNowName: row.diffNowName,
      difficultySource: resolved.source,
      durationMs: num(row.levelLengthInMs),
    };
  });

  const world: WorldPass[] = (options.needWorld ? passFacts : []).map((pass) => ({
    passId: pass.id,
    playerId: pass.playerId,
    levelId: pass.levelId,
    vidUploadTime: pass.vidUploadTime,
    uploadTimeKnown: pass.uploadTimeKnown,
    accuracy: pass.accuracy,
    scoreV2: pass.scoreV2,
    speed: pass.speed,
    isWorldsFirst: pass.isWorldsFirst,
    ancient: pass.ancient,
  }));

  const setMap: Record<string, BadgeSetValues> = {};
  for (const row of sets) {
    const kind = row.kind === 'chart' ? 'chart' : 'difficulty';
    const values = Array.isArray(row.values) ? row.values : [];
    setMap[row.name] = {
      kind,
      values: kind === 'chart' ? values.map((item) => Number(item)) : values.map((item) => String(item)),
    };
  }
  const packLevels: Record<number, number[]> = {};
  for (const row of packs) {
    const list = packLevels[Number(row.packId)] ?? [];
    list.push(Number(row.levelId));
    packLevels[Number(row.packId)] = list;
  }

  const playerIds = [...new Set(passFacts.map((pass) => pass.playerId))];
  const playerUsers: Record<number, string> = {};
  if (playerIds.length) {
    const users = await rows<{ id: string; playerId: number }>(
      'SELECT id, playerId FROM users WHERE playerId IN (:playerIds)',
      { playerIds },
    );
    for (const user of users) playerUsers[Number(user.playerId)] = user.id;
  }
  const creatorUsers: Record<number, string> = {};
  const creators = await rows<{ id: number; userId: string | null }>(
    'SELECT id, userId FROM creators WHERE userId IS NOT NULL',
  );
  for (const creator of creators) {
    if (creator.userId) creatorUsers[Number(creator.id)] = creator.userId;
  }

  const userIds = [...new Set([...Object.values(playerUsers), ...Object.values(creatorUsers)])];
  const ratingsByUser: BadgeCatalog['ratingsByUser'] = {};
  if (userIds.length) {
    const ratings = await rows<{ userId: string; levelId: number; createdAt: Date }>(`
      SELECT d.userId, r.levelId, d.createdAt
      FROM rating_details d
      INNER JOIN ratings r ON r.id = d.ratingId
      WHERE d.userId IN (:userIds)
    `, { userIds });
    for (const rating of ratings) {
      const list = ratingsByUser[rating.userId] ?? [];
      list.push({ levelId: Number(rating.levelId), createdAt: new Date(rating.createdAt).toISOString() });
      ratingsByUser[rating.userId] = list;
    }
  }

  const reviews = await rows<{ definitionId: number; passId: number; status: string }>(
    'SELECT definitionId, passId, status FROM badge_reviews',
  );

  return {
    charts: chartFacts,
    links: linkMap,
    sets: setMap,
    packLevels,
    passes: passFacts,
    world,
    reviews: reviews.map((row) => ({
      definitionId: Number(row.definitionId),
      passId: Number(row.passId),
      status: row.status === 'approved' || row.status === 'rejected' ? row.status : 'pending',
    })),
    ratingsByUser,
    playerUsers,
    creatorUsers,
  };
}
