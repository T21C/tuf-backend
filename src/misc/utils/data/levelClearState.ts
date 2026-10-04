import { Op } from 'sequelize';
import Pass from '@/models/passes/Pass.js';
import Judgement from '@/models/passes/Judgement.js';
import {
  classifyPassesIntoClearSets,
  emptyClearSets,
  flagsFromClearSets,
  type LevelClearFlags,
  type LevelClearSets,
} from './levelClearSets.js';

export type { LevelClearFlags, LevelClearSets } from './levelClearSets.js';
export { classifyPassesIntoClearSets, emptyClearSets, flagsFromClearSets } from './levelClearSets.js';

const JUDGEMENT_CLEAR_ATTRIBUTES = [
  'earlyDouble',
  'earlySingle',
  'ePerfect',
  'perfectMinus',
  'perfect',
  'perfectPlus',
  'lPerfect',
  'lateSingle',
  'lateDouble',
] as const;

/**
 * Load the viewer's non-deleted passes and classify unique level ids as
 * cleared / pure perfect / pure x-perfect. When `levelIds` is omitted, every
 * pass for the player is loaded (pack detail). When provided, only those
 * levels are queried (level list pages).
 */
export async function fetchClearSets(
  playerId: number | null | undefined,
  levelIds?: number[],
): Promise<LevelClearSets> {
  if (!playerId || (levelIds && levelIds.length === 0)) {
    return emptyClearSets();
  }

  const passes = await Pass.findAll({
    where: {
      playerId,
      isDeleted: false,
      ...(levelIds ? { levelId: { [Op.in]: levelIds } } : {}),
    },
    attributes: ['levelId', 'accuracy', 'scoreV2', 'isXPerfectMode'],
    include: [{
      model: Judgement,
      as: 'judgements',
      attributes: [...JUDGEMENT_CLEAR_ATTRIBUTES],
      required: false,
    }],
  });

  return classifyPassesIntoClearSets(passes);
}

/**
 * Annotate level-like objects with the viewer's clear / PP / XPP flags.
 * When there is no playerId or the list is empty, levels are returned
 * unchanged (no clear fields).
 */
export async function annotateLevelsWithClearState<T extends { id?: number | null }>(
  levels: T[],
  playerId: number | null | undefined,
): Promise<(T & LevelClearFlags)[] | T[]> {
  if (!playerId || levels.length === 0) {
    return levels;
  }

  const ids = levels
    .map((level) => level.id)
    .filter((id): id is number => id != null && Number.isFinite(id));

  if (ids.length === 0) {
    return levels;
  }

  const sets = await fetchClearSets(playerId, ids);
  return levels.map((level) => ({
    ...level,
    ...flagsFromClearSets(level.id, sets),
  }));
}
