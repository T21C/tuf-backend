// tuf-search: #mySubmissions #formSubmissions #submissionLinks
import {Op} from 'sequelize';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Pass from '@/models/passes/Pass.js';
import {logger} from '@/server/services/core/LoggerService.js';
import type {MySubmissionDto} from './listService.js';

type DifficultySnap = {name: string; icon: string; color: string};

type DifficultyFields = {name?: string | null; icon?: string | null; color?: string | null};

export function asHttpUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
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

function positiveIds(values: Array<number | null | undefined>): number[] {
  return [...new Set(values.filter((id): id is number => typeof id === 'number' && id > 0))];
}

async function attachChartLevels(results: MySubmissionDto[]): Promise<void> {
  const approved = results.filter((row) => row.kind === 'level' && row.status === 'approved');
  const ids = positiveIds(approved.map((row) => row.createdLevelId));
  if (!ids.length) return;

  const levels = await Level.findAll({
    where: {id: {[Op.in]: ids}, isDeleted: false},
    attributes: ['id', 'diffId'],
    include: [
      {
        model: Difficulty,
        as: 'difficulty',
        required: false,
        attributes: ['name', 'icon', 'color'],
      },
    ],
  });
  const byId = new Map(levels.map((level) => [level.id, level]));

  for (const row of approved) {
    const levelId = row.createdLevelId;
    if (!levelId) continue;
    const level = byId.get(levelId);
    if (!level) continue;
    row.href = `/levels/${level.id}`;
    row.extra.publishedDifficulty = difficultySnap(level);
  }
}

async function attachPassPages(results: MySubmissionDto[]): Promise<void> {
  const approved = results.filter((row) => row.kind === 'pass' && row.status === 'approved');
  const ids = positiveIds(approved.map((row) => row.createdPassId));
  if (!ids.length) return;

  const passes = await Pass.findAll({
    where: {
      id: {[Op.in]: ids},
      [Op.or]: [{isDeleted: false}, {isDeleted: null}],
    },
    attributes: ['id'],
  });
  const liveIds = new Set(passes.map((pass) => pass.id));

  for (const row of approved) {
    const passId = row.createdPassId;
    if (passId && liveIds.has(passId)) row.passHref = `/passes/${passId}`;
  }
}

export async function enrichSubmissionLinks(
  results: MySubmissionDto[],
  _userId: string,
): Promise<void> {
  const settled = await Promise.allSettled([
    attachChartLevels(results),
    attachPassPages(results),
  ]);
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      logger.warn('Failed to attach published submission links', {
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
    }
  }
  for (const row of results) {
    delete row.createdLevelId;
    delete row.createdPassId;
  }
}
