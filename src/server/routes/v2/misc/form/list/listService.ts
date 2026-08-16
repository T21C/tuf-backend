// tuf-search: #mySubmissions #formSubmissions
import {Op, type FindOptions, type Includeable, type Order, type WhereOptions} from 'sequelize';
import {PassSubmission, PassSubmissionJudgements} from '@/models/submissions/PassSubmission.js';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import {escapeForMySQL} from '@/misc/utils/data/searchHelpers.js';
import {getArtistDisplayName, getSongDisplayName} from '@/misc/utils/data/levelHelpers.js';

export type SubmissionKind = 'pass' | 'level';
export type SubmissionStatus = 'pending' | 'approved' | 'declined';
export type SubmissionTypeFilter = 'all' | SubmissionKind;
export type SubmissionSort = 'DATE_DESC' | 'DATE_ASC' | 'STATUS' | 'TYPE';

export type MySubmissionDto = {
  kind: SubmissionKind;
  id: number;
  status: SubmissionStatus;
  createdAt: string;
  videoLink: string | null;
  title: string;
  artist: string | null;
  href: string | null;
  extra: {
    levelId?: number;
    difficulty?: {name: string; icon: string; color: string} | null;
    scoreV2?: number | null;
    accuracy?: number | null;
    speed?: number | null;
    charter?: string | null;
    requestedDiff?: string | null;
  };
};

export type ListMySubmissionsParams = {
  userId: string;
  type: SubmissionTypeFilter;
  status: SubmissionStatus | null;
  query: string;
  sort: SubmissionSort;
  page: number;
  limit: number;
  offset: number;
};

export type ListMySubmissionsResult = {
  results: MySubmissionDto[];
  total: number;
  page: number;
  limit: number;
  offset: number;
};

type SortKeyRow = {
  kind: SubmissionKind;
  id: number;
  createdAt: Date;
  status: SubmissionStatus;
};

const STATUS_RANK: Record<SubmissionStatus, number> = {
  pending: 0,
  approved: 1,
  declined: 2,
};

const KIND_RANK: Record<SubmissionKind, number> = {
  pass: 0,
  level: 1,
};

const PASS_HYDRATE_INCLUDES: Includeable[] = [
  {
    model: Level,
    as: 'level',
    required: false,
    attributes: ['id', 'song', 'artist', 'suffix'],
    include: [
      {
        model: Difficulty,
        as: 'difficulty',
        required: false,
        attributes: ['id', 'name', 'icon', 'color'],
      },
    ],
  },
  {
    model: PassSubmissionJudgements,
    as: 'judgements',
    required: false,
    attributes: [
      'earlyDouble',
      'earlySingle',
      'ePerfect',
      'perfect',
      'lPerfect',
      'lateSingle',
      'lateDouble',
    ],
  },
];

function parseNumericId(value: string): number | null {
  if (!/^\d{1,10}$/.test(value)) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sequelizeOrder(sort: SubmissionSort): Order {
  switch (sort) {
    case 'DATE_ASC':
      return [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ];
    case 'STATUS':
      return [
        ['status', 'ASC'],
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ];
    case 'TYPE':
    case 'DATE_DESC':
    default:
      return [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ];
  }
}

function compareSortKeys(a: SortKeyRow, b: SortKeyRow, sort: SubmissionSort): number {
  if (sort === 'DATE_ASC') {
    const byDate = a.createdAt.getTime() - b.createdAt.getTime();
    if (byDate !== 0) return byDate;
    if (a.id !== b.id) return a.id - b.id;
    return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  }
  if (sort === 'STATUS') {
    const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (byStatus !== 0) return byStatus;
  } else if (sort === 'TYPE') {
    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (byKind !== 0) return byKind;
  }
  const byDate = b.createdAt.getTime() - a.createdAt.getTime();
  if (byDate !== 0) return byDate;
  if (a.id !== b.id) return b.id - a.id;
  return KIND_RANK[a.kind] - KIND_RANK[b.kind];
}

function likeClause(search: string) {
  return {[Op.like]: `%${escapeForMySQL(search)}%`};
}

function buildPassWhere(
  userId: string,
  status: SubmissionStatus | null,
  search: string,
): WhereOptions {
  const where: WhereOptions = {userId};
  if (status) Object.assign(where, {status});
  if (!search) return where;

  const like = likeClause(search);
  const or: WhereOptions[] = [
    {videoLink: like},
    {passer: like},
    {'$level.song$': like},
    {'$level.artist$': like},
  ];
  const numericId = parseNumericId(search);
  if (numericId !== null) {
    or.push({id: numericId}, {levelId: numericId});
  }
  Object.assign(where, {[Op.or]: or});
  return where;
}

function buildLevelWhere(
  userId: string,
  status: SubmissionStatus | null,
  search: string,
): WhereOptions {
  const where: WhereOptions = {userId};
  if (status) Object.assign(where, {status});
  if (!search) return where;

  const like = likeClause(search);
  const or: WhereOptions[] = [
    {song: like},
    {artist: like},
    {charter: like},
    {videoLink: like},
  ];
  const numericId = parseNumericId(search);
  if (numericId !== null) or.push({id: numericId});
  Object.assign(where, {[Op.or]: or});
  return where;
}

function passFindOptions(
  userId: string,
  status: SubmissionStatus | null,
  search: string,
): Pick<FindOptions, 'where' | 'include' | 'subQuery'> {
  const searching = search.length > 0;
  return {
    where: buildPassWhere(userId, status, search),
    include: searching
      ? [{model: Level, as: 'level', attributes: ['id'], required: false}]
      : [],
    subQuery: searching ? false : undefined,
  };
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function cleanLink(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function passTitle(level: Level | null | undefined): string {
  if (!level) return '';
  return getSongDisplayName(level) || level.song || '';
}

function passArtist(level: Level | null | undefined): string | null {
  if (!level) return null;
  return getArtistDisplayName(level) || level.artist || null;
}

function mapPassDto(row: PassSubmission): MySubmissionDto {
  const json = row.toJSON() as PassSubmission;
  const level = json.level ?? row.level ?? null;
  const difficulty = level?.difficulty
    ? {
        name: level.difficulty.name,
        icon: level.difficulty.icon,
        color: level.difficulty.color,
      }
    : null;
  const accuracy = row.judgements?.accuracy ?? json.judgements?.accuracy;
  return {
    kind: 'pass',
    id: json.id,
    status: json.status,
    createdAt: toIso(json.createdAt),
    videoLink: cleanLink(json.videoLink),
    title: passTitle(level),
    artist: passArtist(level),
    href: json.levelId ? `/levels/${json.levelId}` : null,
    extra: {
      levelId: json.levelId,
      difficulty,
      scoreV2: json.scoreV2 ?? null,
      accuracy: typeof accuracy === 'number' && Number.isFinite(accuracy) ? accuracy : null,
      speed: json.speed ?? null,
    },
  };
}

function mapLevelDto(row: LevelSubmission): MySubmissionDto {
  const json = row.toJSON() as LevelSubmission;
  const song = json.song || '';
  const title = json.suffix && song ? `${song} ${json.suffix}` : song;
  return {
    kind: 'level',
    id: json.id,
    status: json.status,
    createdAt: toIso(json.createdAt),
    videoLink: cleanLink(json.videoLink),
    title,
    artist: json.artist || null,
    href: null,
    extra: {
      charter: json.charter || null,
      requestedDiff: json.diff || null,
    },
  };
}

async function listPassSortKeys(
  userId: string,
  status: SubmissionStatus | null,
  search: string,
): Promise<SortKeyRow[]> {
  const options = passFindOptions(userId, status, search);
  const rows = await PassSubmission.findAll({
    ...options,
    attributes: ['id', 'createdAt', 'status'],
  });
  return rows.map((row) => ({
    kind: 'pass' as const,
    id: row.id,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    status: row.status,
  }));
}

async function listLevelSortKeys(
  userId: string,
  status: SubmissionStatus | null,
  search: string,
): Promise<SortKeyRow[]> {
  const rows = await LevelSubmission.findAll({
    where: buildLevelWhere(userId, status, search),
    attributes: ['id', 'createdAt', 'status'],
  });
  return rows.map((row) => ({
    kind: 'level' as const,
    id: row.id,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    status: row.status,
  }));
}

async function hydratePassDtos(ids: number[]): Promise<Map<number, MySubmissionDto>> {
  if (!ids.length) return new Map();
  const rows = await PassSubmission.findAll({
    where: {id: {[Op.in]: ids}},
    include: PASS_HYDRATE_INCLUDES,
  });
  return new Map(rows.map((row) => [row.id, mapPassDto(row)]));
}

async function hydrateLevelDtos(ids: number[]): Promise<Map<number, MySubmissionDto>> {
  if (!ids.length) return new Map();
  const rows = await LevelSubmission.findAll({
    where: {id: {[Op.in]: ids}},
  });
  return new Map(rows.map((row) => [row.id, mapLevelDto(row)]));
}

async function listSingleType(params: ListMySubmissionsParams): Promise<ListMySubmissionsResult> {
  const {userId, type, status, query, sort, page, limit, offset} = params;
  const search = query.trim();

  if (type === 'pass') {
    const searching = search.length > 0;
    const {rows, count} = await PassSubmission.findAndCountAll({
      where: buildPassWhere(userId, status, search),
      include: PASS_HYDRATE_INCLUDES,
      distinct: true,
      subQuery: searching ? false : undefined,
      order: sequelizeOrder(sort),
      limit,
      offset,
    });
    return {
      results: rows.map(mapPassDto),
      total: count,
      page,
      limit,
      offset,
    };
  }

  const {rows, count} = await LevelSubmission.findAndCountAll({
    where: buildLevelWhere(userId, status, search),
    order: sequelizeOrder(sort),
    limit,
    offset,
  });
  return {
    results: rows.map(mapLevelDto),
    total: count,
    page,
    limit,
    offset,
  };
}

export async function listMySubmissions(
  params: ListMySubmissionsParams,
): Promise<ListMySubmissionsResult> {
  const {userId, type, status, query, sort, page, limit, offset} = params;
  const search = query.trim();

  if (type !== 'all') {
    return listSingleType(params);
  }

  const [passKeys, levelKeys] = await Promise.all([
    listPassSortKeys(userId, status, search),
    listLevelSortKeys(userId, status, search),
  ]);
  const merged = [...passKeys, ...levelKeys].sort((a, b) => compareSortKeys(a, b, sort));
  const pageKeys = merged.slice(offset, offset + limit);
  const passIds = pageKeys.filter((row) => row.kind === 'pass').map((row) => row.id);
  const levelIds = pageKeys.filter((row) => row.kind === 'level').map((row) => row.id);
  const [passDtos, levelDtos] = await Promise.all([
    hydratePassDtos(passIds),
    hydrateLevelDtos(levelIds),
  ]);

  const results: MySubmissionDto[] = [];
  for (const key of pageKeys) {
    const dto = key.kind === 'pass' ? passDtos.get(key.id) : levelDtos.get(key.id);
    if (dto) results.push(dto);
  }

  return {
    results,
    total: merged.length,
    page,
    limit,
    offset,
  };
}
