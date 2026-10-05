// tuf-search: #mySubmissions #formSubmissions #submissionLinks
import {Op, type WhereOptions} from 'sequelize';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Pass from '@/models/passes/Pass.js';
import Notification from '@/models/notifications/Notification.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {NOTIFICATION_TYPES} from '@/server/services/notifications/types.js';
import type {MySubmissionDto} from './listService.js';

type DifficultySnap = {name: string; icon: string; color: string};

type DifficultyFields = {name?: string | null; icon?: string | null; color?: string | null};

type LevelMatch = {
  id: number;
  videoLink: string | null;
  dlLink: string | null;
  workshopLink: string | null;
  diffId: number;
  difficulty?: DifficultyFields | null;
};

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export function asHttpUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

function youtubeId(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  let id = '';
  if (host === 'youtu.be') {
    id = url.pathname.split('/').filter(Boolean)[0] ?? '';
  } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v') ?? '';
    else {
      const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
      if (match) id = match[1];
    }
  }
  return YOUTUBE_ID.test(id) ? id : null;
}

function steamFileId(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/[?&]id=(\d{5,})/);
  return match ? match[1] : null;
}

function readPayload(payload: unknown): Record<string, unknown> | null {
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  if (payload && typeof payload === 'object') return payload as Record<string, unknown>;
  return null;
}

function readPositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function submissionIdFromDedup(dedupKey: string | null, prefix: string): number | null {
  if (!dedupKey?.startsWith(`${prefix}:`) || !dedupKey.endsWith(':approved')) return null;
  const raw = dedupKey.slice(prefix.length + 1, -':approved'.length);
  return readPositiveInt(raw);
}

function difficultySnap(level: {diffId?: number | null; difficulty?: DifficultyFields | null}): DifficultySnap | null {
  const difficulty = level.difficulty;
  if (!level.diffId || level.diffId <= 0 || !difficulty?.name) return null;
  return {
    name: difficulty.name,
    icon: difficulty.icon ?? '',
    color: difficulty.color ?? '',
  };
}

function linkScore(
  submission: Pick<MySubmissionDto, 'videoLink' | 'downloadLink' | 'workshopLink'>,
  level: LevelMatch,
): number {
  let score = 0;
  const submissionDownload = submission.downloadLink?.trim() ?? '';
  const levelDownload = level.dlLink?.trim() ?? '';
  if (submissionDownload && levelDownload && submissionDownload === levelDownload) score += 4;

  const submissionWorkshop = steamFileId(submission.workshopLink);
  const levelWorkshop = steamFileId(level.workshopLink);
  if (submissionWorkshop && levelWorkshop && submissionWorkshop === levelWorkshop) score += 3;

  const submissionVideo = youtubeId(submission.videoLink);
  const levelVideo = youtubeId(level.videoLink);
  if (submissionVideo && levelVideo && submissionVideo === levelVideo) score += 2;
  else if (
    submission.videoLink &&
    level.videoLink &&
    submission.videoLink.trim() === level.videoLink.trim()
  ) {
    score += 2;
  }
  return score;
}

async function idsFromApprovalNotifications(
  userId: string,
  submissionIds: number[],
  type: string,
  prefix: string,
  field: 'levelId' | 'passId',
): Promise<Map<number, number>> {
  const found = new Map<number, number>();
  if (!submissionIds.length) return found;
  const rows = await Notification.findAll({
    where: {
      userId,
      type,
      dedupKey: {[Op.in]: submissionIds.map((id) => `${prefix}:${id}:approved`)},
    },
    attributes: ['dedupKey', 'payload'],
  });
  for (const row of rows) {
    const submissionId = submissionIdFromDedup(row.dedupKey, prefix);
    const payload = readPayload(row.payload);
    const targetId = readPositiveInt(payload?.[field]);
    if (submissionId && targetId) found.set(submissionId, targetId);
  }
  return found;
}

async function attachChartLevels(results: MySubmissionDto[], userId: string): Promise<void> {
  const approved = results.filter((row) => row.kind === 'level' && row.status === 'approved');
  if (!approved.length) return;

  const noted = await idsFromApprovalNotifications(
    userId,
    approved.map((row) => row.id),
    NOTIFICATION_TYPES.ChartSubmissionApproved,
    'chart-submission',
    'levelId',
  );
  const notedIds = [...new Set(noted.values())];
  const notedLevels = notedIds.length
    ? await Level.findAll({
        where: {id: {[Op.in]: notedIds}, isDeleted: false},
        attributes: ['id', 'diffId'],
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
            required: false,
            attributes: ['name', 'icon', 'color'],
          },
        ],
      })
    : [];
  const notedById = new Map(notedLevels.map((level) => [level.id, level]));

  const unresolved: MySubmissionDto[] = [];
  for (const row of approved) {
    const level = notedById.get(noted.get(row.id) ?? -1);
    if (!level) {
      unresolved.push(row);
      continue;
    }
    row.href = `/levels/${level.id}`;
    row.extra.publishedDifficulty = difficultySnap(level);
  }
  if (!unresolved.length) return;

  const videoLinks = new Set<string>();
  const youtubeIds = new Set<string>();
  const downloads = new Set<string>();
  const steamIds = new Set<string>();
  for (const row of unresolved) {
    const video = row.videoLink?.trim();
    if (video) videoLinks.add(video);
    const videoId = youtubeId(row.videoLink);
    if (videoId) youtubeIds.add(videoId);
    if (row.downloadLink) downloads.add(row.downloadLink);
    const workshopId = steamFileId(row.workshopLink);
    if (workshopId) steamIds.add(workshopId);
  }

  const or: WhereOptions[] = [];
  if (videoLinks.size) or.push({videoLink: {[Op.in]: [...videoLinks]}});
  for (const id of youtubeIds) or.push({videoLink: {[Op.like]: `%${id}%`}});
  if (downloads.size) or.push({dlLink: {[Op.in]: [...downloads]}});
  for (const id of steamIds) {
    or.push({workshopLink: {[Op.like]: `%id=${id}`}});
    or.push({workshopLink: {[Op.like]: `%id=${id}&%`}});
  }
  if (!or.length) return;

  const candidates = (await Level.findAll({
    where: {isDeleted: false, [Op.or]: or},
    attributes: ['id', 'videoLink', 'dlLink', 'workshopLink', 'diffId'],
    include: [
      {
        model: Difficulty,
        as: 'difficulty',
        required: false,
        attributes: ['name', 'icon', 'color'],
      },
    ],
  })) as unknown as LevelMatch[];

  for (const row of unresolved) {
    let best: LevelMatch | null = null;
    let bestScore = 0;
    for (const candidate of candidates) {
      const score = linkScore(row, candidate);
      if (score < 2) continue;
      if (!best || score > bestScore || (score === bestScore && candidate.id > best.id)) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best) continue;
    row.href = `/levels/${best.id}`;
    row.extra.publishedDifficulty = difficultySnap(best);
  }
}

async function attachPassPages(results: MySubmissionDto[], userId: string): Promise<void> {
  const approved = results.filter((row) => row.kind === 'pass' && row.status === 'approved');
  if (!approved.length) return;

  const noted = await idsFromApprovalNotifications(
    userId,
    approved.map((row) => row.id),
    NOTIFICATION_TYPES.PassSubmissionApproved,
    'pass-submission',
    'passId',
  );
  const notedIds = [...new Set(noted.values())];
  const livePasses = notedIds.length
    ? await Pass.findAll({
        where: {id: {[Op.in]: notedIds}, isDeleted: false},
        attributes: ['id'],
      })
    : [];
  const liveIds = new Set(livePasses.map((pass) => pass.id));

  const unresolved: MySubmissionDto[] = [];
  for (const row of approved) {
    const passId = noted.get(row.id);
    if (passId && liveIds.has(passId)) row.passHref = `/passes/${passId}`;
    else unresolved.push(row);
  }

  const clauses = unresolved.flatMap((row) => {
    const levelId = row.extra.levelId;
    const videoLink = row.videoLink?.trim();
    if (!levelId || !videoLink) return [];
    return [{levelId, videoLink, isDeleted: false}];
  });
  if (!clauses.length) return;

  const found = await Pass.findAll({
    where: {[Op.or]: clauses},
    attributes: ['id', 'levelId', 'videoLink', 'scoreV2'],
  });
  const grouped = new Map<string, Pass[]>();
  for (const pass of found) {
    const key = `${pass.levelId}\0${(pass.videoLink ?? '').trim()}`;
    const list = grouped.get(key) ?? [];
    list.push(pass);
    grouped.set(key, list);
  }

  for (const row of unresolved) {
    const key = `${row.extra.levelId}\0${(row.videoLink ?? '').trim()}`;
    const candidates = grouped.get(key);
    if (!candidates?.length) continue;
    const target = Number(row.extra.scoreV2);
    const best = candidates.slice().sort((a, b) => {
      const distance = (score: number | null) =>
        Number.isFinite(target) && score != null ? Math.abs(score - target) : Number.POSITIVE_INFINITY;
      const byScore = distance(a.scoreV2) - distance(b.scoreV2);
      if (byScore !== 0) return byScore;
      return b.id - a.id;
    })[0];
    row.passHref = `/passes/${best.id}`;
  }
}

export async function enrichSubmissionLinks(
  results: MySubmissionDto[],
  userId: string,
): Promise<void> {
  const tasks = [
    attachChartLevels(results, userId),
    attachPassPages(results, userId),
  ];
  const settled = await Promise.allSettled(tasks);
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      logger.warn('Failed to attach published submission links', {
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
    }
  }
}
