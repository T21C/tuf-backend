import {Op, OrderItem} from 'sequelize';
import Pass from '../../../models/passes/Pass.js';
import Level from '../../../models/levels/Level.js';
import Player from '../../../models/players/Player.js';
import Judgement from '../../../models/passes/Judgement.js';
import {Auth} from '../../../middleware/auth.js';
import {getIO} from '../../../utils/socket.js';
import {calcAcc, IJudgements} from '../../../utils/CalcAcc.js';
import {getScoreV2} from '../../../utils/CalcScore.js';
import sequelize from '../../../config/db.js';
import Difficulty from '../../../models/levels/Difficulty.js';
import {sseManager} from '../../../utils/sse.js';
import User from '../../../models/auth/User.js';
import {excludePlaceholder} from '../../../middleware/excludePlaceholder.js';
import {PlayerStatsService} from '../../../services/PlayerStatsService.js';
import {Router, Request, Response} from 'express';
import { escapeForMySQL } from '../../../utils/searchHelpers.js';
import { logger } from '../../../services/LoggerService.js';
import ElasticsearchService from '../../../services/ElasticsearchService.js';

// Search query types and interfaces
interface FieldSearch {
  field: string;
  value: string;
  exact: boolean;
}

interface SearchGroup {
  terms: FieldSearch[];
  operation: 'AND' | 'OR';
}

const router: Router = Router();

// Add this helper function after the router declaration
export const sanitizeTextInput = (input: string | null | undefined): string => {
  if (input === null || input === undefined) return '';
  return input.trim();
};

export async function updateWorldsFirstStatus(
  levelId: number,
  transaction?: any,
) {
  // Find the earliest non-deleted pass for this level from non-banned players
  const earliestPass = await Pass.findOne({
    where: {
      levelId,
      isDeleted: false
    },
    include: [
      {
        model: Player,
        as: 'player',
        where: {isBanned: false},
        required: true,
      },
      {
        model: Level,
        as: 'level',
        where: {
          isDeleted: false,
          isHidden: false
        },
        required: true
      }
    ],
    order: [['vidUploadTime', 'ASC']],
    transaction,
  });

  // Reset all passes for this level to not be world's first
  await Pass.update(
    {isWorldsFirst: false},
    {
      where: {levelId},
      transaction,
    },
  );

  // If we found an earliest pass, mark it as world's first
  if (earliestPass) {
    await Pass.update(
      {isWorldsFirst: true},
      {
        where: {id: earliestPass.id},
        transaction,
      },
    );
  }
}

// Helper function to parse field-specific searches (e.g., "video:Example")
const parseFieldSearch = (term: string): FieldSearch | null => {
  // Trim the term here when parsing
  const trimmedTerm = term.trim();
  if (!trimmedTerm) return null;

  // Check for exact match with equals sign
  const exactMatch = trimmedTerm.match(/^(video|player)=(.+)$/i);
  if (exactMatch) {
    return {
      field: exactMatch[1].toLowerCase(),
      value: exactMatch[2].trim(),
      exact: true,
    };
  }

  // Check for partial match with colon
  const partialMatch = trimmedTerm.match(/^(video|player):(.+)$/i);
  if (partialMatch) {
    return {
      field: partialMatch[1].toLowerCase(),
      value: partialMatch[2].trim(),
      exact: false,
    };
  }

  return null;
};

// Helper function to parse the entire search query
const parseSearchQuery = (query: string): SearchGroup[] => {
  if (!query) return [];

  // Split by | for OR groups and handle trimming here
  const groups = query
    .split('|')
    .map(group => {
      // Split by comma for AND terms within each group
      const terms = group
        .split(',')
        .map(term => term.trim())
        .filter(term => term.length > 0)
        .map(term => {
          const fieldSearch = parseFieldSearch(term);
          if (fieldSearch) {
            return fieldSearch;
          }
          return {
            field: 'any',
            value: term.trim(),
            exact: false,
          };
        });

      return {
        terms,
        operation: 'AND' as const,
      };
    })
    .filter(group => group.terms.length > 0); // Remove empty groups

  return groups;
};

// Helper function to build field-specific search condition
const buildFieldSearchCondition = async (
  fieldSearch: FieldSearch,
): Promise<any> => {
  const {field, value, exact} = fieldSearch;

  // Handle special characters in the search value
  const escapedValue = escapeForMySQL(value);
  const searchValue = exact ? escapedValue : `%${escapedValue}%`;

  // Create the base search condition
  const searchCondition = {[exact ? Op.eq : Op.like]: searchValue};

  // For field-specific searches
  if (field === 'video') {
    return {videoLink: searchCondition};
  }

  if (field === 'player') {
    return sequelize.where(
      sequelize.fn('LOWER', sequelize.col('player.name')),
      exact ? Op.eq : Op.like,
      sequelize.fn('LOWER', searchValue),
    );
  }

  // For general searches (field === 'any')
  const escapedLikeValue = `%${escapedValue}%`;
  return {
    [Op.or]: [
      sequelize.where(
        sequelize.fn('LOWER', sequelize.col('player.name')),
        Op.like,
        sequelize.fn('LOWER', escapedLikeValue),
      ),
      sequelize.where(
        sequelize.fn('LOWER', sequelize.col('level.song')),
        Op.like,
        sequelize.fn('LOWER', escapedLikeValue),
      ),
      {videoLink: {[Op.like]: escapedLikeValue}},
    ],
  };
};

// Build where clause
const buildWhereClause = async (query: any) => {
  const where: any = {};
  const conditions: any[] = [];

  // Handle deleted filter
  if (query.deletedFilter) {
    if (query.deletedFilter === 'hide') {
      conditions.push({isDeleted: false});
    } else if (query.deletedFilter === 'only') {
      conditions.push({isDeleted: true});
    }
  } else {
    conditions.push({isDeleted: false});
  }
  

  // Handle key flag filter
  if (query.keyFlag) {
    switch (query.keyFlag) {
      case '12k':
        conditions.push({is12K: true});
        break;
      case '16k':
        conditions.push({is16K: true});
        break;
      // 'all' case doesn't need a condition as it means no filtering
    }
  }

  // Handle difficulty filtering
  const difficultyConditions: any[] = [];
  const specialDifficultyConditions: any[] = [];

  // Handle PGU range if provided
  if (query.minDiff || query.maxDiff) {
    const [fromDiff, toDiff] = await Promise.all([
      query.minDiff
        ? Difficulty.findOne({
            where: {name: query.minDiff, type: 'PGU'},
            attributes: ['id', 'sortOrder'],
          })
        : null,
      query.maxDiff
        ? Difficulty.findOne({
            where: {name: query.maxDiff, type: 'PGU'},
            attributes: ['id', 'sortOrder'],
          })
        : null,
    ]);

    if (fromDiff || toDiff) {
      const pguDifficulties = await Difficulty.findAll({
        where: {
          type: 'PGU',
          sortOrder: {
            ...(fromDiff && {[Op.gte]: fromDiff.sortOrder}),
            ...(toDiff && {[Op.lte]: toDiff.sortOrder}),
          },
        },
        attributes: ['id'],
      });

      if (pguDifficulties.length > 0) {
        difficultyConditions.push({
          '$level.diffId$': {[Op.in]: pguDifficulties.map(d => d.id)},
        });
      }
    }
  }
  
  // Handle special difficulties if provided
  if (query.specialDifficulties?.length > 0) {
    const specialDiffs = await Difficulty.findAll({
      where: {
        name: {[Op.in]: query.specialDifficulties},
        type: 'SPECIAL',
      },
      attributes: ['id'],
    });
    
    if (specialDiffs.length > 0) {
      specialDifficultyConditions.push({
        '$level.diffId$': {[Op.in]: specialDiffs.map(d => d.id)},
      });
    }
  }

  // Add difficulty conditions to the where clause if any exist
  if (difficultyConditions.length > 0 || specialDifficultyConditions.length > 0) {
    conditions.push({[Op.or]: {[Op.or]: [...difficultyConditions, ...specialDifficultyConditions]}});
  }
  
  // Handle text search with new parsing
  if (query.query) {
    const searchGroups = parseSearchQuery(query.query.trim());

    if (searchGroups.length > 0) {
      const orConditions = await Promise.all(
        searchGroups.map(async group => {
          const andConditions = await Promise.all(
            group.terms.map(term => buildFieldSearchCondition(term)),
          );

          return andConditions.length === 1
            ? andConditions[0]
            : {[Op.and]: andConditions};
        }),
      );

      conditions.push(
        orConditions.length === 1 ? orConditions[0] : {[Op.or]: orConditions},
      );
    }
  }

  // Combine all conditions
  if (conditions.length > 0) {
    where[Op.and] = conditions;
  }

  return where;
};

// Get sort options
const getSortOptions = (sort?: string): OrderItem[] => {
  const direction = sort?.split('_')[1] || 'DESC';
  switch (sort?.split('_')[0]) {
    case 'RECENT':
      return [['vidUploadTime', direction]];
    case 'SCORE':
      return [
        ['scoreV2', direction],
        ['id', 'DESC'], // Secondary sort by newest first
      ];
    case 'XACC':
      return [
        ['accuracy', direction],
        ['scoreV2', 'DESC'], // Secondary sort by highest score
        ['id', 'DESC'], // Tertiary sort by newest first
      ];
    case 'DIFF':
      return [
        [{model: Level, as: 'level'}, 'diffId', direction],
        ['scoreV2', 'DESC'], // Secondary sort by highest score
        ['id', 'DESC'], // Tertiary sort by newest first
      ];
    case "RANDOM":
      return [sequelize.random()];
    default:
      return [
        ['scoreV2', 'DESC'], // Default to highest score
        ['id', 'DESC'], // Secondary sort by newest first
      ];
  }
};

// Unified search bridge function
export async function unifiedPassSearch(query: any, useElasticsearch: boolean = true) {
  try {
    if (useElasticsearch) {
      const elasticsearchService = ElasticsearchService.getInstance();
      const startTime = Date.now();
      const { hits, total } = await elasticsearchService.searchPasses(query.query, {
        deletedFilter: query.deletedFilter,
        minDiff: query.minDiff,
        maxDiff: query.maxDiff,
        keyFlag: query.keyFlag,
        specialDifficulties: query.specialDifficulties,
        sort: query.sort,
        offset: query.offset,
        limit: query.limit
      });

      const duration = Date.now() - startTime;
      if (duration > 1000) {
        logger.debug(`[Passes] Search completed in ${duration}ms with ${total} results`);
      }

      return {
        count: total,
        results: hits
      };
    } else {
      // Legacy MySQL search
      const where = await buildWhereClause({
        deletedFilter: query.deletedFilter,
        minDiff: query.minDiff,
        maxDiff: query.maxDiff,
        keyFlag: query.keyFlag,
        levelId: query.levelId,
        player: query.player,
        query: query.query,
        specialDifficulties: query.specialDifficulties,
      });

      const order = getSortOptions(query.sort);
      const offsetNum = Math.max(0, Number(query.offset) || 0);
      const limitNum = Math.min(100, Math.max(1, Number(query.limit) || 30));

      const allIds = await Pass.findAll({
        where,
        include: [
          {
            model: Player,
            as: 'player',
            where: {isBanned: false},
            required: true,
          },
          {
            model: Level,
            as: 'level',
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
                required: false,
              },
            ],
          },
        ],
        order,
        attributes: ['id'],
        raw: true,
      });

      const paginatedIds = allIds
        .map((pass: any) => pass.id)
        .slice(offsetNum, offsetNum + limitNum);

      const results = await Pass.findAll({
        where: {
          ...where,
          id: {
            [Op.in]: paginatedIds,
          },
        },
        include: [
          {
            model: Player,
            as: 'player',
            attributes: ['name', 'country', 'isBanned'],
            where: {isBanned: false},
            required: true,
          },
          {
            model: Level,
            as: 'level',
            where: {isHidden: false},
            attributes: ['song', 'artist', 'baseScore'],
            include: [
              {
                model: Difficulty,
                as: 'difficulty',
              },
            ],
          },
          {
            model: Judgement,
            as: 'judgements',
          },
        ],
        order,
      });

      return {
        count: allIds.length,
        results,
      };
    }
  } catch (error) {
    logger.error('Error in unified pass search:', error);
    throw error;
  }
}

// Helper function to ensure string type
export const ensureString = (value: any): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0]?.toString();
  if (value?.toString) return value.toString();
  return undefined;
};

import announcements from './announcements.js';
import modification from './modification.js';
import search from './search.js';

router.use('/', announcements);
router.use('/', modification);
router.use('/', search);

export default router;



