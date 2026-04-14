import { Op } from 'sequelize';
import Difficulty from '@/models/levels/Difficulty.js';
import CurationType from '@/models/curations/CurationType.js';
import LevelTag from '@/models/levels/LevelTag.js';
import { logger } from '@/server/services/core/LoggerService.js';

export async function resolveDifficultyRange(minDiff?: string, maxDiff?: string): Promise<number[]> {
  try {
    const [fromDiff, toDiff] = await Promise.all([
      minDiff
        ? Difficulty.findOne({
            where: { name: minDiff, type: 'PGU' },
            attributes: ['id', 'sortOrder'],
          })
        : null,
      maxDiff
        ? Difficulty.findOne({
            where: { name: maxDiff, type: 'PGU' },
            attributes: ['id', 'sortOrder'],
          })
        : null,
    ]);

    if (fromDiff || toDiff) {
      const pguDifficulties = await Difficulty.findAll({
        where: {
          type: 'PGU',
          sortOrder: {
            ...(fromDiff && { [Op.gte]: fromDiff.sortOrder }),
            ...(toDiff && { [Op.lte]: toDiff.sortOrder }),
          },
        },
        attributes: ['id'],
      });

      return pguDifficulties.map(d => d.id);
    }

    return [];
  } catch (error) {
    logger.error('Error resolving difficulty range:', error);
    return [];
  }
}

/** Canonical difficulty order from DB (id → sortOrder) for Elasticsearch script sorts. LEGACY is omitted so those ids sort as missing. */
export async function getDifficultySortOrderByDiffId(): Promise<Record<string, number>> {
  try {
    const rows = await Difficulty.findAll({
      where: {
        type: { [Op.ne]: 'LEGACY' },
      },
      attributes: ['id', 'sortOrder'],
    });
    const map: Record<string, number> = {};
    for (const d of rows) {
      map[String(d.id)] = d.sortOrder;
    }
    return map;
  } catch (error) {
    logger.error('Error loading difficulty sort orders:', error);
    return {};
  }
}

/**
 * Difficulties with non-zero baseScore only (id → baseScore) for Elasticsearch script sorts.
 * Omitted ids are treated as 0 fallback, matching DB-backed resolution without denormalizing every difficulty field.
 */
export async function getDifficultyBaseScoreByDiffId(): Promise<Record<string, number>> {
  try {
    const rows = await Difficulty.findAll({
      where: {
        baseScore: { [Op.ne]: 0 },
      },
      attributes: ['id', 'baseScore'],
    });
    const map: Record<string, number> = {};
    for (const d of rows) {
      map[String(d.id)] = d.baseScore;
    }
    return map;
  } catch (error) {
    logger.error('Error loading difficulty base scores:', error);
    return {};
  }
}

export async function resolveSpecialDifficulties(specialDifficulties?: string[]): Promise<number[]> {
  try {
    if (!specialDifficulties?.length) return [];

    const specialDiffs = await Difficulty.findAll({
      where: {
        name: { [Op.in]: specialDifficulties },
        type: 'SPECIAL',
      },
      attributes: ['id'],
    });

    return specialDiffs.map(d => d.id);
  } catch (error) {
    logger.error('Error resolving special difficulties:', error);
    return [];
  }
}

export async function resolveCurationTypes(curationTypeNames?: string[]): Promise<number[]> {
  try {
    if (!curationTypeNames?.length) return [];

    const curationTypes = await CurationType.findAll({
      where: {
        name: { [Op.in]: curationTypeNames },
      },
      attributes: ['id'],
    });

    return curationTypes.map(t => t.id);
  } catch (error) {
    logger.error('Error resolving curation types:', error);
    return [];
  }
}

export async function resolveTags(tagNames?: string[]): Promise<number[]> {
  try {
    if (!tagNames?.length) return [];

    const tags = await LevelTag.findAll({
      where: {
        name: { [Op.in]: tagNames },
      },
      attributes: ['id'],
    });

    return tags.map(t => t.id);
  } catch (error) {
    logger.error('Error resolving tags:', error);
    return [];
  }
}
