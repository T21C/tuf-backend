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
