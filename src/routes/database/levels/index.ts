import {Op, Order, OrderItem, literal, Transaction, WhereOptions} from 'sequelize';
import Level from '../../../models/levels/Level.js';
import Pass from '../../../models/passes/Pass.js';
import Player from '../../../models/players/Player.js';
import Judgement from '../../../models/passes/Judgement.js';
import sequelize from '../../../config/db.js';
import Difficulty from '../../../models/levels/Difficulty.js';
import {sseManager} from '../../../utils/sse.js';
import {getScoreV2} from '../../../utils/CalcScore.js';
import {calcAcc} from '../../../utils/CalcAcc.js';
import Team from '../../../models/credits/Team.js';
import Creator from '../../../models/credits/Creator.js';
import LevelCredit from '../../../models/levels/LevelCredit.js';
import LevelAlias from '../../../models/levels/LevelAlias.js';
import {PlayerStatsService} from '../../../services/PlayerStatsService.js';
import {Router, Request, Response} from 'express';
import { escapeForMySQL } from '../../../utils/searchHelpers.js';
import User from '../../../models/auth/User.js';
import { logger } from '../../../utils/logger.js';
import {CreatorAlias} from '../../../models/credits/CreatorAlias.js';
import { checkMemoryUsage } from '../../../utils/memUtils.js';
import { TeamAlias } from '../../../models/credits/TeamAlias.js';
import LevelSearchView from '../../../models/levels/LevelSearchView.js';
import LevelLikes from '../../../models/levels/LevelLikes.js';
import aliases from "./aliases.js";
import modification from "./modification.js";
import aprilFools from "./aprilFools.js";
import announcements from "./announcements.js";
import search from "./search.js";
import { ILevel } from '../../../interfaces/models/index.js';

const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();

const MAX_LIMIT = 500;
// Add this helper function after the router declaration
export const sanitizeTextInput = (input: string | null | undefined): string => {
  if (input === null || input === undefined) return '';
  return input.trim();
};

// After any level update that affects scores (baseScore, difficulty, etc.)
export async function handleLevelUpdate() {
  try {
    // Schedule a reload of all player stats
    await playerStatsService.reloadAllStats();
  } catch (error) {
    console.error('Error reloading player stats after level update:', error);
  }
}

export const handlePassUpdates = async (levelId: number, diffId: number, baseScore: number) => {
  try {
    const recalcTransaction = await sequelize.transaction({
      isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED,
    });

    try {
      const passes = await Pass.findAll({
        where: { levelId },
        include: [
          {
            model: Judgement,
            as: 'judgements',
          },
        ],
        transaction: recalcTransaction,
      });

      // Process passes in batches
      const batchSize = 100;
      for (let i = 0; i < passes.length; i += batchSize) {
        const batch = passes.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async passData => {
            const pass = passData.dataValues;
            if (!pass.judgements) return;

            const accuracy = calcAcc(pass.judgements);

            const currentDifficulty = await Difficulty.findByPk(
              diffId,
              {
                transaction: recalcTransaction,
              },
            );

            if (!currentDifficulty) {
              console.error(`No difficulty found for pass ${pass.id}`);
              return;
            }

            const levelData = {
              baseScore: baseScore || 0,
              difficulty: currentDifficulty,
            };

            const scoreV2 = getScoreV2(
              {
                speed: pass.speed || 1,
                judgements: pass.judgements,
                isNoHoldTap: pass.isNoHoldTap || false,
              },
              levelData,
            );

            await Pass.update(
              { accuracy, scoreV2 },
              {
                where: { id: pass.id },
                transaction: recalcTransaction,
              },
            );
          }),
        );
      }

      // Schedule stats update for affected players
      const affectedPlayerIds = new Set(passes.map(pass => pass.playerId));

      playerStatsService.updatePlayerStats(Array.from(affectedPlayerIds));


      await recalcTransaction.commit();

      // Broadcast updates
      sseManager.broadcast({ type: 'levelUpdate' });
      sseManager.broadcast({
        type: 'passUpdate',
        data: {
          levelId,
          action: 'levelUpdate',
        },
      });
    } catch (error) {
      await recalcTransaction.rollback();
      throw error;
    }
  } catch (error) {
    console.error('Error in async operations after level update:', error);
  }
}
// Search query types and interfaces
export interface FieldSearch {
  field: string;
  value: string;
  exact: boolean;
}

export interface SearchGroup {
  terms: FieldSearch[];
  operation: 'AND' | 'OR';
}

// Helper function to parse field-specific searches (e.g., "song:Example")
export const parseFieldSearch = (term: string): FieldSearch | null => {
  // Trim the term here when parsing
  const trimmedTerm = term.trim();
  if (!trimmedTerm) return null;

  // Check for exact match with equals sign
  const exactMatch = trimmedTerm.match(/^(song|artist|charter|team)=(.+)$/i);
  if (exactMatch) {
    return {
      field: exactMatch[1].toLowerCase(),
      value: exactMatch[2].trim(),
      exact: true,
    };
  }

  // Check for partial match with colon
  const partialMatch = trimmedTerm.match(/^(song|artist|charter|team):(.+)$/i);
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
export const parseSearchQuery = (query: string): SearchGroup[] => {
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
export const buildFieldSearchCondition = async (
  fieldSearch: FieldSearch,
  userId?: string | null
): Promise<any> => {
  const {field, value, exact} = fieldSearch;

  // Handle special characters in the search value
  const searchValue = exact ? value : `%${escapeForMySQL(value)}%`;

  // Create the base search condition - use MySQL's case-insensitive comparison
  const searchCondition = exact 
    ? {[Op.eq]: searchValue} 
    : {[Op.like]: searchValue};

  // For field-specific searches
  if (field !== 'any') {
    // Special handling for team search
    if (field === 'team') {
      // Find team aliases that match the search term
      const teamAliasMatches = await TeamAlias.findAll({
        where: {
          name: searchCondition
        },
        attributes: ['teamId'],
        raw: true
      });
      
      const teamIds = teamAliasMatches.map((alias: { teamId: number }) => alias.teamId);
      
      return {
        [Op.or]: [
          { team: searchCondition },
          ...(teamIds.length > 0 ? [{ teamId: { [Op.in]: teamIds } }] : [])
        ]
      };
    }

    const condition = {
      [field]: searchCondition,
    };

    // Also search in aliases for song and artist fields
    if (field === 'song' || field === 'artist') {
      const aliasMatches = await LevelAlias.findAll({
        where: {
          field,
          [Op.or]: [
            {alias: searchCondition}, 
            {originalValue: searchCondition}
          ],
        },
        attributes: ['levelId'],
      });

      if (aliasMatches.length > 0) {
        const result = {
          [Op.or]: [
            condition,
            {id: {[Op.in]: aliasMatches.map(a => a.levelId)}},
          ],
        };
        return result;
      }
    }

    return condition;
  }

  const aliasMatches = await LevelAlias.findAll({
    where: {
      [Op.or]: [
        {alias: searchCondition}, 
        {originalValue: searchCondition}
      ],
    },
    attributes: ['levelId'],
  });

  const creatorAliasMatches = await CreatorAlias.findAll({
    where: {
      name: searchCondition
    }
  });
  
  const teamAliasMatches = await TeamAlias.findAll({
    where: {
      name: searchCondition
    },
    attributes: ['teamId'],
    raw: true
  });
  // Fix the mapping to correctly access creatorId
  const creatorIds = creatorAliasMatches.map(alias => {
    return alias.dataValues ? alias.dataValues.creatorId : alias.creatorId;
  });
  
  // Instead of using the $ syntax for levelCredits.creatorId, we'll handle this differently
  // by finding levels with matching creator IDs first
  let levelIdsWithMatchingCreators: number[] = [];
  if (creatorAliasMatches.length > 0) {
    // Find all levels that have credits with the matching creator IDs
    const levelsWithCreators = await LevelCredit.findAll({
      where: {
        creatorId: { [Op.in]: creatorIds }
      },
      attributes: ['levelId'],
      raw: true
    });
    
    levelIdsWithMatchingCreators = levelsWithCreators.map(credit => credit.levelId);
  }
  
  const result = {
    [Op.or]: [
      {song: searchCondition},
      {artist: searchCondition},
      {charter: searchCondition},
      {team: searchCondition},
      ...(aliasMatches.length > 0
        ? [{id: {[Op.in]: aliasMatches.map(a => a.levelId)}}]
        : []),
      ...(levelIdsWithMatchingCreators.length > 0
        ? [{id: {[Op.in]: levelIdsWithMatchingCreators}}]
        : []),
      ...(teamAliasMatches.length > 0 ? [{ teamId: { [Op.in]: teamAliasMatches } }] : []),
    ],
  };
  return result;
};

export async function buildWhereClause(
  query: any, 
  deletedFilter?: string, 
  clearedFilter?: string, 
  onlyMyLikes?: boolean,
  userId?: string | null) : Promise<any> {
  const where: any = {};
  const conditions: any[] = [];

  // Handle deleted filter
  if (deletedFilter === 'hide') {
    conditions.push({
      [Op.and]: [{isDeleted: false}, {isHidden: false}],
    });
  } else if (deletedFilter === 'only') {
    conditions.push({
      [Op.or]: [{isDeleted: true}, {isHidden: true}],
    });
  }

  // Handle cleared filter
  if (clearedFilter && clearedFilter === 'hide') {
    conditions.push({
      clears: 0,
    });
  } else if (clearedFilter && clearedFilter === 'only') {
    conditions.push({
      clears: {
        [Op.ne]: 0,
      },
    });
  }

  if (onlyMyLikes && userId) {
    logger.debug(`${await LevelLikes.findAll({where: {userId}, attributes: ['levelId']}).then(likes => likes.map(l => l.levelId))}`);
    conditions.push({
      id: {
        [Op.in]: await LevelLikes.findAll({where: {userId}, attributes: ['levelId']}).then(likes => likes.map(l => l.levelId))
      }
    });
  }

  // Handle text search with new parsing
  if (query) {
    // Add type check to ensure query.query is a string
    if (typeof query !== 'string') {
      console.warn(`Invalid query type: ${typeof query}. Expected string.`);
      // Either skip this condition or convert to string
      query = String(query);
    }
    const searchGroups = parseSearchQuery(query.trim());

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
export const getSortOptions = (sort?: string): {searchOrder: Order, fetchOrder: Order} => {
  const direction = sort?.split('_').pop() === 'ASC' ? 'ASC' : 'DESC';
  switch (sort?.split('_').slice(0, -1).join('_')) {
    case 'RECENT':
      return {
        searchOrder: [['id', direction]], 
        fetchOrder: [['id', direction]]
      };
    case 'DIFF':
      return {
        searchOrder: [['sortOrder', direction], ['id', 'DESC']],
        fetchOrder: [[{model: Difficulty, as: 'difficulty'}, 'sortOrder', direction], ['id', 'DESC']]
      };
    case 'CLEARS':
      return {
        searchOrder: [['clears', direction], ['id', 'DESC']],
        fetchOrder: [['clears', direction], ['id', 'DESC']]
      };
    case 'LIKES':
      return {
        searchOrder: [['likes', direction], ['id', 'DESC']],
        fetchOrder: [['likes', direction], ['id', 'DESC']]
      };
    case 'RATING_ACCURACY':
      return {
        searchOrder: [['ratingAccuracy', direction], ['id', 'DESC']],
        fetchOrder: [['ratingAccuracy', direction], ['id', 'DESC']]
      };
    case 'RATING_ACCURACY_VOTES':
      return {
        searchOrder: [['totalRatingAccuracyVotes', direction], ['id', 'DESC']],
        fetchOrder: [['totalRatingAccuracyVotes', direction], ['id', 'DESC']]
      };
    case 'RANDOM':
      return {
        searchOrder: [[literal('RAND()'), 'ASC']],
        fetchOrder: [[literal('RAND()'), 'ASC']]
      };
    default:
      return {
        searchOrder: [['id', 'DESC']], 
        fetchOrder: [['id', 'DESC']]
      }; // Default to recent descending
  }
};

export async function filterLevels(
  query: any, 
  pguRange?: {from: string, to: string}, 
  specialDifficulties?: string[], 
  sort?: any, 
  offset?: number, 
  limit?: number, 
  deletedFilter?: string, 
  clearedFilter?: string, 
  onlyMyLikes?: boolean, 
  userId?: string | null) {
  const where = await buildWhereClause(
    query,
    deletedFilter,
    clearedFilter,
    onlyMyLikes,
    userId
  );

  // Add difficulty filtering conditions
  const difficultyConditions: any[] = [];

  // Handle PGU range if provided
  if (pguRange?.from || pguRange?.to) {
    const [fromDiff, toDiff] = await Promise.all([
      pguRange.from
        ? Difficulty.findOne({
            where: {name: pguRange.from, type: 'PGU'},
            attributes: ['id', 'sortOrder'],
          })
        : null,
      pguRange.to
        ? Difficulty.findOne({
            where: {name: pguRange.to, type: 'PGU'},
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
          diffId: {[Op.in]: pguDifficulties.map(d => d.id)},
        });
      }
    }
  }

  // Handle special difficulties if provided
  if (specialDifficulties && specialDifficulties.length > 0) {
    const specialDiffs = await Difficulty.findAll({
      where: {
        name: {[Op.in]: specialDifficulties},
        type: 'SPECIAL',
      },
      attributes: ['id'],
    });

    if (specialDiffs.length > 0) {
      difficultyConditions.push({
        diffId: {[Op.in]: specialDiffs.map(d => d.id)},
      });
    }
  }

  // Add difficulty conditions to the where clause if any exist
  if (difficultyConditions.length > 0) {
    where[Op.and] = [
      ...(where[Op.and] || []),
      {[Op.or]: difficultyConditions},
    ];
  }

  // Get sort options
  const {searchOrder, fetchOrder}= getSortOptions(sort as string);
  let startTime = Date.now();
  
  const normalizedLimit = limit ? Math.min(Math.max(limit, 1), MAX_LIMIT) : 30; // took me 13 hours to find out this was needed :3
  const normalizedOffset = offset && offset > 0 ? offset : 0;
  
  // Use the LevelSearchView for the initial search
  const searchResults = await LevelSearchView.findAll({
    where,
    offset: normalizedOffset,
    limit: normalizedLimit + 1,
    order: searchOrder,
  });
  
  logger.debug(`search query took ${Date.now() - startTime}ms`);
  
  // Extract unique level IDs to avoid duplicates
  const uniqueIds = searchResults.map(level => level.id);
  logger.debug(`Found ${uniqueIds.length} unique levels`);
  
  // Apply pagination to the unique IDs
  let hasMore = uniqueIds.length > normalizedLimit;
  if (hasMore) {
    uniqueIds.pop();
  }
  
  logger.debug(`Pagination: ${normalizedOffset} to ${normalizedOffset + normalizedLimit}, returning ${uniqueIds.length} levels with ${hasMore ? 'more' : 'no more'} results`);

  startTime = Date.now();
  const results = await Level.findAll({
    where: {
      id: {
        [Op.in]: uniqueIds,
      },
    },
    include: [
      {
        model: Difficulty,
        as: 'difficulty',
        required: false,
        attributes: ['id', 'type'],
      },
      {
        model: Pass,
        as: 'passes',
        required: false,
        attributes: ['id', 'accuracy', 'isDeleted', 'isHidden', 'isWorldsFirst'],
        include: [
          {
            model: Player,
            as: 'player',
            required: false,
            attributes: ["pfp"],
            include: [
              {
                model: User,
                as: 'user',
                attributes: ["avatarUrl"],
              }
            ]
          }
        ]
      },
      {
        model: LevelAlias,
        as: 'aliases',
        required: false,
      },
      {
        model: LevelCredit,
        as: 'levelCredits',
        required: false,
        include: [
          {
            model: Creator,
            as: 'creator',
            attributes: ['name'],
          },
        ],
      },
      {
        model: Team,
        as: 'teamObject',
        required: false,
        attributes: ['name'],
      }
    ],
    order: fetchOrder,
  });
  
  logger.debug(`fetch query took ${Date.now() - startTime}ms`);
  logger.debug(`memory usage on fetch: `);
  checkMemoryUsage()
  return {results, hasMore};
}

// Add HEAD endpoint for permission check
router.head('/:id', async (req: Request, res: Response) => {
  try {
    const levelId = parseInt(req.params.id);
    if (isNaN(levelId)) {
      return res.status(400).end();
    }

    const level = await Level.findOne({
      where: { id: levelId },
      attributes: ['isDeleted']
    });

    if (!level) {
      return res.status(404).end();
    }

    // If level is deleted and user is not super admin, return 403
    if (level.isDeleted && !req.user?.isSuperAdmin) {
      return res.status(403).end();
    }

    return res.status(200).end();
  } catch (error) {
    console.error('Error checking level permissions:', error);
    return res.status(500).end();
  }
});


router.use('/', aliases);
router.use('/', modification);
router.use('/', aprilFools);
router.use('/', announcements);
router.use('/', search);
export default router;
