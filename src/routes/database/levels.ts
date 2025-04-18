import {Op, Order, OrderItem, literal, Transaction} from 'sequelize';
import Level from '../../models/levels/Level.js';
import Pass from '../../models/passes/Pass.js';
import Rating from '../../models/levels/Rating.js';
import Player from '../../models/players/Player.js';
import Judgement from '../../models/passes/Judgement.js';
import {Auth} from '../../middleware/auth.js';
import {getIO} from '../../utils/socket.js';
import sequelize from '../../config/db.js';
import RatingDetail from '../../models/levels/RatingDetail.js';
import Difficulty from '../../models/levels/Difficulty.js';
import {sseManager} from '../../utils/sse.js';
import {getScoreV2} from '../../utils/CalcScore.js';
import {calcAcc} from '../../utils/CalcAcc.js';
import Team from '../../models/credits/Team.js';
import Creator from '../../models/credits/Creator.js';
import LevelCredit from '../../models/levels/LevelCredit.js';
import LevelAlias from '../../models/levels/LevelAlias.js';
import {PlayerStatsService} from '../../services/PlayerStatsService.js';
import {Router, Request, Response} from 'express';
import { escapeForMySQL } from '../../utils/searchHelpers.js';
import User from '../../models/auth/User.js';
import { seededShuffle, getDailySeed, getRandomSeed } from '../../utils/random.js';
import { env } from 'process';
const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();

const ENABLE_ROULETTE = env.APRIL_FOOLS === "true";

// Add after router declaration
const userTimeouts = new Map<string, number>();
const bigWheelTimeout = 1000 * 15; // 30 seconds
const individualLevelTimeout = 1000 * 60 * 5; // 5 minutes

// Add helper function to check timeout
const checkUserTimeout = (userId: string): number | null => {
  const timeout = userTimeouts.get(userId);
  if (!timeout) return null;
  
  const now = Date.now();
  if (now >= timeout) {
    userTimeouts.delete(userId);
    return null;
  }
  
  return Math.ceil((timeout - now) / 1000);
};

// Add level timeouts map
const levelTimeouts = new Map<number, number>();

// Add check level timeout function
const checkLevelTimeout = (levelId: number): number | null => {
  const timeout = levelTimeouts.get(levelId);
  if (!timeout) return null;
  
  const remainingTime = timeout - Date.now();
  if (remainingTime <= 0) {
    levelTimeouts.delete(levelId);
    return null;
  }
  
  return Math.ceil(remainingTime / 1000);
};

// Add this helper function after the router declaration
const sanitizeTextInput = (input: string | null | undefined): string => {
  if (input === null || input === undefined) return '';
  return input.trim();
};

// After any level update that affects scores (baseScore, difficulty, etc.)
async function handleLevelUpdate() {
  try {
    // Schedule a reload of all player stats
    await playerStatsService.reloadAllStats();
  } catch (error) {
    console.error('Error reloading player stats after level update:', error);
  }
}

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

// Helper function to parse field-specific searches (e.g., "song:Example")
const parseFieldSearch = (term: string): FieldSearch | null => {
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
  const searchValue = exact ? value : `%${escapeForMySQL(value)}%`;

  // Create the base search condition
  const searchCondition = {[exact ? Op.eq : Op.like]: searchValue};

  // For field-specific searches
  if (field !== 'any') {
    // Special handling for team search
    if (field === 'team') {
      return {
        [Op.or]: [
          { team: searchCondition },
          { '$teamObject.name$': searchCondition }
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
          [Op.or]: [{alias: searchCondition}, {originalValue: searchCondition}],
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

  // For general searches (field === 'any')
  const aliasMatches = await LevelAlias.findAll({
    where: {
      [Op.or]: [{alias: searchCondition}, {originalValue: searchCondition}],
    },
    attributes: ['levelId'],
  });

  const result = {
    [Op.or]: [
      {song: searchCondition},
      {artist: searchCondition},
      {charter: searchCondition},
      {team: searchCondition},
      {'$teamObject.name$': searchCondition},
      ...(aliasMatches.length > 0
        ? [{id: {[Op.in]: aliasMatches.map(a => a.levelId)}}]
        : []),
    ],
  };
  return result;
};

const buildWhereClause = async (query: any) => {
  const where: any = {};
  const conditions: any[] = [];

  // Handle deleted filter
  if (query.deletedFilter === 'hide') {
    conditions.push({
      [Op.and]: [{isDeleted: false}, {isHidden: false}],
    });
  } else if (query.deletedFilter === 'only') {
    conditions.push({
      [Op.or]: [{isDeleted: true}, {isHidden: true}],
    });
  }

  // Handle cleared filter
  if (query.clearedFilter && query.clearedFilter === 'hide') {
    conditions.push({
      clears: 0,
    });
  } else if (query.clearedFilter && query.clearedFilter === 'only') {
    conditions.push({
      clears: {
        [Op.gt]: 0,
      },
    });
  }

  // Handle text search with new parsing
  if (query.query) {
    // Add type check to ensure query.query is a string
    if (typeof query.query !== 'string') {
      console.warn(`Invalid query type: ${typeof query.query}. Expected string.`);
      // Either skip this condition or convert to string
      query.query = String(query.query);
    }
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
const getSortOptions = (sort?: string): Order => {
  switch (sort) {
    case 'RECENT_DESC':
      return [['id', 'DESC']];
    case 'RECENT_ASC':
      return [['id', 'ASC']];
    case 'DIFF_ASC':
      return [
        [{model: Difficulty, as: 'difficulty'}, 'sortOrder', 'ASC'],
        ['id', 'DESC'],
      ];
    case 'DIFF_DESC':
      return [
        [{model: Difficulty, as: 'difficulty'}, 'sortOrder', 'DESC'],
        ['id', 'DESC'],
      ];
    case 'CLEARS_ASC':
      return [
        ['clears', 'ASC'],
        ['id', 'DESC'],
      ];
    case 'CLEARS_DESC':
      return [
        ['clears', 'DESC'],
        ['id', 'DESC'],
      ];
    case 'RANDOM':
      return [[literal('RAND()'), 'ASC']];
    default:
      return [['id', 'DESC']]; // Default to recent descending
  }
};

async function filterLevels(query: any, pguRange?: {from: string, to: string}, specialDifficulties?: string[], sort?: any, offset?: number, limit?: number, deletedFilter?: string, clearedFilter?: string) {
  const where = await buildWhereClause({
    query,
    deletedFilter,
    clearedFilter,
  });

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
  const order = getSortOptions(sort as string);

  // First get all IDs in correct order
  const allIds = await Level.findAll({
    where,
    include: [
      {
        model: Difficulty,
        as: 'difficulty',
        required: false,
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
          },
        ],
      },
      {
        model: Team,
        as: 'teamObject',
        required: false,
      }
    ],
    order,
    attributes: ['id'],
    raw: true,
  });

  // Then get paginated results
  let paginatedIds: number[] = [];
  if (limit && limit > 0) {
    paginatedIds = allIds
      .map(level => level.id)
    .slice(
      Number(offset) || 0,
      (Number(offset) || 0) + (Number(limit) || 30),
    );
  }
  else {
    paginatedIds = allIds.map(level => level.id);
  }

  const results = await Level.findAll({
    where: {
      ...where,
      id: {
        [Op.in]: paginatedIds,
      },
    },
    include: [
      {
        model: Difficulty,
        as: 'difficulty',
        required: false,
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
          },
        ],
      },
      {
        model: Team,
        as: 'teamObject',
        required: false,
      }
    ],
    order,
  });

  return {results, count: allIds.length};
}

// Get all levels with filtering and pagination
router.get('/', async (req: Request, res: Response) => {
  try {
    const {query, sort, offset, limit, deletedFilter, clearedFilter, pguRange, specialDifficulties} =
      req.query;
    const pguRangeObj = pguRange ? {from: (pguRange as string).split(',')[0], to: (pguRange as string).split(',')[1]} : undefined;
    const specialDifficultiesObj = specialDifficulties ? (specialDifficulties as string).split(',') : undefined;
    // Build the base where clause using the shared function
    const {results, count} = await filterLevels(
      query, 
      pguRangeObj, 
      specialDifficultiesObj, 
      sort, 
      parseInt(offset as string), 
      parseInt(limit as string), 
      deletedFilter as string, 
      clearedFilter as string);

    return res.json({
      count,
      results,
    });
  } catch (error) {
    console.error('Error fetching levels:', error);
    return res.status(500).json({error: 'Failed to fetch levels'});
  }
});

// Add the new filtering endpoint
router.post('/filter', async (req: Request, res: Response) => {
  try {
    const {pguRange, specialDifficulties} = req.body;
    const {query, sort, offset, limit, deletedFilter, clearedFilter} =
      req.query;

    // Build the base where clause using the shared function
    const {results, count} = await filterLevels(
      query, 
      pguRange, 
      specialDifficulties, 
      sort, 
      parseInt(offset as string), 
      parseInt(limit as string), 
      deletedFilter as string, 
      clearedFilter as string);

    return res.json({
      count,
      results,
    });
  } catch (error) {
    console.error('Error filtering levels:', error);
    console.log("query:", req.query);
    console.log("body:", req.body);
    return res.status(500).json({error: 'Failed to filter levels'});
  }
});


// Get simplified level data for slot machine
router.get('/all-levels', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  if (!ENABLE_ROULETTE) {
    return res.status(727).json({ error: 'April fools over, roulette is disabled' });
  }
  try {
    if (req.user) {
      const remainingTime = checkUserTimeout(req.user.id);
      if (remainingTime !== null) {
        return res.json({
          timeout: true,
          remainingTime
        });
      }
    }

    // Generate a daily seed
    const seed = getRandomSeed();
    
    // Get all levels
    const levels = await Level.findAll({
      where: {
        isDeleted: false,
        isHidden: false,
        diffId: {
          [Op.ne]: 0
        }
      },
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
          required: false,
          attributes: ['color', 'id']
        }
      ],
      attributes: ['id', 'song']
    });

    const modLevels = levels.filter(level => level.id % 4 === 0);
    // Shuffle array using seeded random
    const shuffledLevels = seededShuffle(modLevels, seed);

    // Transform the data to match slot machine format
    const slotItems = shuffledLevels.map(level => ({
      id: level.id,
      name: level.song,
      color: level.difficulty?.color || '#666666',
      diffId: level.difficulty?.id
    }));

    return res.json({
      items: slotItems,
      seed: seed
    });
  } catch (error) {
    console.error('Error fetching slot machine levels:', error);
    return res.status(500).json({ error: 'Failed to fetch slot machine levels' });
  }
});

router.get('/byId/:id', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    const levelId = parseInt(req.params.id);
    
  // Check if levelId is not a valid number
  if (isNaN(levelId) || !Number.isInteger(levelId) || levelId <= 0) {
    return res.status(400).json({error: 'Invalid level ID'});
  }

  const level = await Level.findOne({
    where: { id: levelId },
    include: [
      {
        model: Difficulty,
        as: 'difficulty',
        required: false,
      },
      {
        model: Pass,
        as: 'passes',
        required: false,
        attributes: ['id'],
      },
      {
        model: LevelCredit,
        as: 'levelCredits',
        required: false,
        include: [
          {
            model: Creator,
            as: 'creator',
          },
        ],
      },
      {
        model: LevelAlias,
        as: 'aliases',
        required: false,
      },
      {
        model: Team,
        as: 'teamObject',
        required: false,
      }
    ],
  });

  if (!level) {    
    return res.status(404).json({ error: 'Level not found' });
  }

  // If level is deleted and user is not super admin, return 404
  if (level.isDeleted && !req.user?.isSuperAdmin) {
    return res.status(404).json({ error: 'Level not found' });
  }

    return res.json(level);
  } catch (error) {
    console.error(`Error fetching level by ID ${req.params.id}:`, (error instanceof Error ? error.toString() : String(error)).slice(0, 1000));
    return res.status(500).json({ error: 'Failed to fetch level by ID' });
  }
});

// Add HEAD endpoint for byId permission check
router.head('/byId/:id', Auth.addUserToRequest(), async (req: Request, res: Response) => {
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

router.get('/withRatings/:id', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    // Use a READ COMMITTED transaction to avoid locks from updates
    if (isNaN(parseInt(req.params.id))) {
      return res.status(400).json({ error: 'Invalid level ID' });
    }
    const transaction = await sequelize.transaction({
      isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED,
    });

    try {
      const level = await Level.findOne({
        where: { id: parseInt(req.params.id) },
        include: [
          {
            model: Pass,
            as: 'passes',
            include: [
              {
                model: Player,
                as: 'player',
              },
              {
                model: Judgement,
                as: 'judgements',
              },
            ],
          },
          {
            model: Difficulty,
            as: 'difficulty',
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
              },
            ],
          },
          {
            model: Team,
            as: 'teamObject',
            required: false,
          },
        ],
        transaction,
      });

      const ratings = await Rating.findOne({
        where: {
          levelId: parseInt(req.params.id),
          [Op.not]: {confirmedAt: null}
        },
        include: [
          {
            model: RatingDetail,
            as: 'details',
            include: [
              {
                model: User,
                as: 'user',
                attributes: ['username', 'avatarUrl'],
              },
            ],
          },
        ],
        transaction,
      });

      await transaction.commit();

      if (!level) {
        return res.status(404).json({ error: 'Level not found' });
      }

      // If level is deleted and user is not super admin, return 404
      if (level.isDeleted && !req.user?.isSuperAdmin) {
        return res.status(404).json({ error: 'Level not found' });
      }
      
      if (!ENABLE_ROULETTE) {
        return res.json({
          level,
          ratings
        })
      }

      const timeout = checkLevelTimeout(level.id);

      return res.json({
        level,
        ratings,
        timeout
      });
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  } catch (error) {
    console.error('Error fetching level:', error);
    return res.status(500).json({ error: 'Failed to fetch level' });
  }
});

// Get a single level by ID
router.get('/:id', Auth.addUserToRequest(), async (req: Request, res: Response) => {
  try {
    // Use a READ COMMITTED transaction to avoid locks from updates
    if (isNaN(parseInt(req.params.id))) {
      return res.status(400).json({ error: 'Invalid level ID' });
    }
    const transaction = await sequelize.transaction({
      isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED,
    });

    try {
      const level = await Level.findOne({
        where: { id: parseInt(req.params.id) },
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
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
              },
            ],
          },
          {
            model: Team,
            as: 'teamObject',
            required: false,
          },
        ],
        transaction,
      });
      
      await transaction.commit();

      if (!level) {
        return res.status(404).json({ error: 'Level not found' });
      }

      // If level is deleted and user is not super admin, return 404
      if (level.isDeleted && !req.user?.isSuperAdmin) {
        return res.status(404).json({ error: 'Level not found' });
      }

      return res.json(level);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  } catch (error) {
    console.error('Error fetching level:', error);
    return res.status(500).json({ error: 'Failed to fetch level' });
  }
});

// Update a level
router.put('/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  // Start a transaction with REPEATABLE READ to ensure consistency during the update
  const transaction = await sequelize.transaction({
    isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ,
  });
  
  try {
    const levelId = parseInt(req.params.id);
    if (isNaN(levelId)) {
      return res.status(400).json({error: 'Invalid level ID'});
    }

    // First get the current level data
    const level = await Level.findOne({
      where: {id: levelId},
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
          required: false,
        },
      ],
      transaction,
      lock: true, // Lock this row for update
    });

    if (!level) {
      await transaction.rollback();
      return res.status(404).json({error: 'Level not found'});
    }

    // Handle rating creation/deletion if toRate is changing
    if (
      typeof req.body.toRate === 'boolean' &&
      req.body.toRate !== level.toRate
    ) {
      if (req.body.toRate) {
        // Create new rating if toRate is being set to true
        const existingRating = await Rating.findOne({
          where: {
            levelId,
            confirmedAt: null,
          },
          transaction,
        });

        if (!existingRating) {
          // Check if rerateNum starts with 'p' or 'P' followed by a number
          const lowDiff = req.body.rerateNum
            ? /^[pP]\d/.test(req.body.rerateNum)
            : false;

          await Rating.create(
            {
              levelId,
              currentDifficultyId: 0,
              lowDiff,
              requesterFR: '',
              averageDifficultyId: null,
              communityDifficultyId: null,
              confirmedAt: null,
            },
            {transaction},
          );
        }
      } else {
        // Delete rating if toRate is being set to false
        const existingRating = await Rating.findOne({
          where: {
            levelId,
            confirmedAt: null,
          },
          transaction,
        });

        if (existingRating) {
          // Delete rating details first
          await Rating.update({
            confirmedAt: new Date(),
          }, {
            where: {id: existingRating.id},
            transaction,
          });
        }
      }
    }

    // Update lowDiff flag if there's an existing rating
    const existingRating = await Rating.findOne({
      where: {
        levelId,
        confirmedAt: null,
      },
      transaction,
    });

    if (existingRating) {
      const lowDiff =
        /^[pP]\d/.test(req.body.rerateNum) ||
        /^[pP]\d/.test(existingRating.dataValues.requesterFR);
      await existingRating.update({lowDiff}, {transaction});
    }

    // Handle flag changes
    let isDeleted = level.isDeleted;
    let isHidden = level.isHidden;
    let isAnnounced = level.isAnnounced;

    // If isDeleted is being set to true, also set isHidden to true
    if (req.body.isDeleted === true) {
      isDeleted = true;
      isHidden = true;
    }
    // If isDeleted is being set to false, also set isHidden to false
    else if (req.body.isDeleted === false) {
      isDeleted = false;
      isHidden = false;
    }
    // If only isHidden is being changed, respect that change
    else if (req.body.isHidden !== undefined) {
      isHidden = req.body.isHidden;
    }

    // Handle isAnnounced logic
    if (req.body.isAnnounced !== undefined) {
      isAnnounced = req.body.isAnnounced;
    } else {
      // Set isAnnounced to true if toRate is being set to true
      if (req.body.toRate === true) {
        isAnnounced = true;
      }
      // Set isAnnounced to false if toRate is being set to false and it was previously true
      else if (req.body.toRate === false && level.toRate === true) {
        isAnnounced = false;
      }
    }

    let previousDiffId = req.body.previousDiffId ?? level.diffId ?? 0;
    previousDiffId =
      previousDiffId === req.body.diffId && req.body.previousDiffId === undefined
        ? level.previousDiffId
        : previousDiffId;
    
    let previousBaseScore = req.body.previousBaseScore ?? level.baseScore ?? 0;
    previousBaseScore =
      previousBaseScore === req.body.baseScore
        ? level.previousBaseScore
        : previousBaseScore;
    // Clean up the update data to handle null values correctly
    const updateData = {
      song: sanitizeTextInput(req.body.song),
      artist: sanitizeTextInput(req.body.artist),
      creator: sanitizeTextInput(req.body.creator),
      charter: sanitizeTextInput(req.body.charter),
      vfxer: sanitizeTextInput(req.body.vfxer),
      team: sanitizeTextInput(req.body.team),
      diffId: req.body.diffId || 0,
      previousDiffId,
      baseScore:
        req.body.baseScore === ''
          ? null
          : (req.body.baseScore ?? level.baseScore),
      previousBaseScore,
      videoLink: sanitizeTextInput(req.body.videoLink),
      dlLink: sanitizeTextInput(req.body.dlLink),
      workshopLink: sanitizeTextInput(req.body.workshopLink),
      publicComments: sanitizeTextInput(req.body.publicComments),
      rerateNum: sanitizeTextInput(req.body.rerateNum),
      toRate: req.body.toRate ?? level.toRate,
      rerateReason: sanitizeTextInput(req.body.rerateReason),
      isDeleted,
      isHidden,
      isAnnounced,
      updatedAt: new Date(),
    };

    // Update the level
    await Level.update(updateData, {
      where: {id: levelId},
      transaction,
    });

    // Fetch the updated record with minimal associations for the response
    const updatedLevel = await Level.findOne({
      where: {id: levelId},
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
          required: false,
        },
        {
          model: Pass,
          as: 'passes',
          required: false,
          attributes: ['id'],
        },
      ],
      transaction,
    });

    await transaction.commit();

    // Send response immediately after commit
    const response = {
      message: 'Level updated successfully',
      level: updatedLevel,
    };
    res.json(response);

    // Handle cache updates and score recalculations asynchronously
    (async () => {
      try {
        // Start a new transaction for score recalculations
        const recalcTransaction = await sequelize.transaction({
          isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED,
        });

        try {
          // If baseScore or diffId changed, recalculate all passes for this level
          if (
            req.body.baseScore !== undefined ||
            req.body.diffId !== undefined
          ) {
            const passes = await Pass.findAll({
              where: {levelId},
              include: [
                {
                  model: Judgement,
                  as: 'judgements',
                },
              ],
              transaction: recalcTransaction,
            });

            // Process passes in batches to avoid memory issues
            const batchSize = 100;
            for (let i = 0; i < passes.length; i += batchSize) {
              const batch = passes.slice(i, i + batchSize);
              await Promise.all(
                batch.map(async passData => {
                  const pass = passData.dataValues;
                  if (!pass.judgements) return;

                  const accuracy = calcAcc(pass.judgements);

                  // Get the current difficulty data
                  const currentDifficulty = await Difficulty.findByPk(
                    updateData.diffId || pass.level?.diffId,
                    {
                      transaction: recalcTransaction,
                    },
                  );

                  if (!currentDifficulty) {
                    console.error(`No difficulty found for pass ${pass.id}`);
                    return;
                  }

                  // Create properly structured level data for score calculation
                  const levelData = {
                    baseScore:
                      updateData.baseScore || pass.level?.baseScore || 0,
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
                    {accuracy, scoreV2},
                    {
                      where: {id: pass.id},
                      transaction: recalcTransaction,
                    },
                  );
                }),
              );
            }

            // Schedule stats update for affected players
            const affectedPlayerIds = new Set(
              passes.map(pass => pass.playerId),
            );
            playerStatsService.updatePlayerStats(Array.from(affectedPlayerIds));
          }

          await recalcTransaction.commit();

          // Broadcast updates
          sseManager.broadcast({type: 'ratingUpdate'});
          sseManager.broadcast({type: 'levelUpdate'});
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
    })()
      .then(() => {
        return;
      })
      .catch(error => {
        console.error('Error in async operations after level update:', error);
        return;
      });
    return;
  } catch (error) {
    await transaction.rollback();
    console.error('Error updating level:', error);
    return res.status(500).json({error: 'Failed to update level'});
  }
});

// Toggle rating status for a level
router.put('/:id/toRate', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const levelId = parseInt(req.params.id);
    if (isNaN(levelId)) {
      await transaction.rollback();
      return res.status(400).json({error: 'Invalid level ID'});
    }

    // Get the level
    const level = await Level.findByPk(levelId, {transaction});
    if (!level) {
      await transaction.rollback();
      return res.status(404).json({error: 'Level not found'});
    }

    // Check if rating exists
    const existingRating = await Rating.findOne({
      where: {
        levelId,
        confirmedAt: null,
      },
      transaction,
    });

    if (existingRating) {
      // If rating exists, mark it as confirmed
      await Rating.update({
        confirmedAt: new Date(),
      }, {
        where: {id: existingRating.id},
        transaction,
      });

      // Update level with consistent announcement flag handling
      await Level.update(
        {
          toRate: false,
          isAnnounced: false, // Reset announcement flag when removing from rating
        },
        {
          where: {id: levelId},
          transaction,
        },
      );

      await transaction.commit();

      // Broadcast updates
      sseManager.broadcast({type: 'ratingUpdate'});
      sseManager.broadcast({type: 'levelUpdate'});

      return res.json({
        message: 'Rating removed successfully',
        toRate: false,
      });
    } else {
      // Create new rating with default values
      const newRating = await Rating.create(
        {
          levelId,
          currentDifficultyId: 0,
          lowDiff: false,
          requesterFR: '',
          averageDifficultyId: null,
        },
        {transaction},
      );

      // Update level to mark for rating with consistent announcement flag handling
      await Level.update(
        {
          toRate: true,
          isAnnounced: true, // Set announcement flag when adding to rating
        },
        {
          where: {id: levelId},
          transaction,
        },
      );

      await transaction.commit();

      // Broadcast updates
      sseManager.broadcast({type: 'ratingUpdate'});
      sseManager.broadcast({type: 'levelUpdate'});

      return res.json({
        message: 'Rating created successfully',
        toRate: true,
        ratingId: newRating.id,
      });
    }
  } catch (error) {
    await transaction.rollback();
    console.error('Error toggling rating status:', error);
    return res.status(500).json({
      error: 'Failed to toggle rating status',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

router.delete('/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const levelId = parseInt(req.params.id);
      if (isNaN(levelId)) {
        return res.status(400).json({error: 'Invalid level ID'});
      }

      const level = await Level.findOne({
        where: {id: levelId.toString()},
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
            required: false,
          },
          {
            model: Pass,
            as: 'passes',
            required: false,
            attributes: ['id'],
          },
        ],
        transaction,
      });

      if (!level) {
        return res.status(404).json({error: 'Level not found'});
      }

      await Level.update(
        {isDeleted: true},
        {
          where: {id: levelId.toString()},
          transaction,
        },
      );

      await transaction.commit();

      // Send response immediately after commit
      const response = {
        message: 'Level soft deleted successfully',
        level: level,
      };
      res.json(response);

      // Handle cache updates and broadcasts asynchronously
      (async () => {
        try {
          // Get affected players before deletion
          const affectedPasses = await Pass.findAll({
            where: {levelId},
            attributes: ['playerId'],
          });

          const affectedPlayerIds = new Set(
            affectedPasses.map(pass => pass.playerId),
          );

          // Schedule stats update for affected players
          playerStatsService.updatePlayerStats(Array.from(affectedPlayerIds));


          // Broadcast updates
          sseManager.broadcast({type: 'levelUpdate'});
          sseManager.broadcast({type: 'ratingUpdate'});
        } catch (error) {
          console.error(
            'Error in async operations after level deletion:',
            error,
          );
        }
      })()
        .then(() => {
          return;
        })
        .catch(error => {
          console.error(
            'Error in async operations after level deletion:',
            error,
          );
          return;
        });
      return;
    } catch (error) {
      await transaction.rollback();
      console.error('Error soft deleting level:', error);
      return res.status(500).json({error: 'Failed to soft delete level'});
    }
  },
);

router.patch('/:id/restore', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const {id} = req.params;

      const level = await Level.findOne({
        where: {id: parseInt(id)},
        transaction,
      });

      if (!level) {
        await transaction.rollback();
        return res.status(404).json({error: 'Level not found'});
      }

      // Restore both isDeleted and isHidden flags
      await Level.update(
        {
          isDeleted: false,
          isHidden: false,
        },
        {
          where: {id: parseInt(id)},
          transaction,
        },
      );

      // Reload the level to get updated data
      await level.reload({
        include: [
          {
            model: Difficulty,
            as: 'difficulty',
          },
          {
            model: Pass,
            as: 'passes',
            required: false,
            attributes: ['id'],
          },
        ],
        transaction,
      });

      await transaction.commit();

      // Broadcast updates
      sseManager.broadcast({type: 'levelUpdate'});
      sseManager.broadcast({type: 'ratingUpdate'});

      // Reload stats for new level
      await handleLevelUpdate();

      return res.json({
        message: 'Level restored successfully',
        level: level,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error restoring level:', error);
      return res.status(500).json({error: 'Failed to restore level'});
    }
  },
);

// Get unannounced new levels
router.get('/unannounced/new', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const levels = await Level.findAll({
      where: {
        isAnnounced: false,
        diffId: {
          [Op.ne]: 0,
        },
        previousDiffId: {
          [Op.or]: [{[Op.eq]: 0}],
        },
        isDeleted: false,
      },
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
        },
      ],
      order: [['createdAt', 'DESC']],
    });

    return res.json(levels);
  } catch (error) {
    console.error('Error fetching unannounced new levels:', error);
    return res
      .status(500)
      .json({error: 'Failed to fetch unannounced new levels'});
  }
});

// Get unannounced rerates
router.get('/unannounced/rerates', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const levels = await Level.findAll({
      where: {
        isAnnounced: false,
        diffId: {
          [Op.ne]: 0,
        },
        previousDiffId: {
          [Op.and]: [{[Op.ne]: 0}],
        },
        isDeleted: false,
      },
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
        },
        {
          model: Difficulty,
          as: 'previousDifficulty',
        },
        {
          model: LevelCredit,
          as: 'levelCredits',
        },
        {
          model: Team,
          as: 'teamObject',
        },
      ],
      order: [['updatedAt', 'DESC']],
    });

    return res.json(levels);
  } catch (error) {
    console.error('Error fetching unannounced rerates:', error);
    return res.status(500).json({error: 'Failed to fetch unannounced rerates'});
  }
});

// Mark levels as announced - single endpoint for all announcement operations
router.post('/announce', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const {levelIds} = req.body;

    if (!Array.isArray(levelIds)) {
      return res.status(400).json({error: 'levelIds must be an array'});
    }

    await Level.update(
      {isAnnounced: true},
      {
        where: {
          id: {
            [Op.in]: levelIds,
          },
        },
      },
    );

    // Broadcast level update
    sseManager.broadcast({type: 'levelUpdate'});

    return res.json({success: true, message: 'Levels marked as announced'});
  } catch (error) {
    console.error('Error marking levels as announced:', error);
    return res.status(500).json({error: 'Failed to mark levels as announced'});
  }
});

// Mark a single level as announced
router.post('/markAnnounced/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const levelId = parseInt(req.params.id);
    if (isNaN(levelId)) {
      return res.status(400).json({error: 'Invalid level ID'});
    }

    const level = await Level.findByPk(levelId);
    if (!level) {
      return res.status(404).json({error: 'Level not found'});
    }

    await level.update({isAnnounced: true});

    // Broadcast level update
    sseManager.broadcast({type: 'levelUpdate'});

    return res.json({success: true});
  } catch (error) {
    console.error('Error marking level as announced:', error);
    return res.status(500).json({
      error: 'Failed to mark level as announced',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Toggle hidden status
router.patch('/:id/toggle-hidden', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const {id} = req.params;

      const level = await Level.findOne({
        where: {id: parseInt(id)},
        transaction,
      });

      if (!level) {
        await transaction.rollback();
        return res.status(404).json({error: 'Level not found'});
      }

      // Toggle the hidden status
      await Level.update(
        {isHidden: !level.isHidden},
        {
          where: {id: parseInt(id)},
          transaction,
        },
      );

      await transaction.commit();


      // Broadcast updates
      sseManager.broadcast({type: 'levelUpdate'});

      return res.json({
        message: `Level ${level.isHidden ? 'unhidden' : 'hidden'} successfully`,
        isHidden: !level.isHidden,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error toggling level hidden status:', error);
      return res.status(500).json({
        error: 'Failed to toggle level hidden status',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);


// Get all aliases for a level
router.get('/:id/aliases', async (req: Request, res: Response) => {
  try {
    const levelId = parseInt(req.params.id);
    if (isNaN(levelId)) {
      return res.status(400).json({error: 'Invalid level ID'});
    }

    const aliases = await LevelAlias.findAll({
      where: {levelId},
    });

    return res.json(aliases);
  } catch (error) {
    console.error('Error fetching level aliases:', error);
    return res.status(500).json({error: 'Failed to fetch level aliases'});
  }
});

// Add new alias(es) for a level with optional propagation
router.post('/:id/aliases', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const levelId = parseInt(req.params.id);
      if (isNaN(levelId)) {
        await transaction.rollback();
        return res.status(400).json({error: 'Invalid level ID'});
      }

      const {field, alias, matchType = 'exact', propagate = false} = req.body;

      // Sanitize text inputs
      const sanitizedAlias = sanitizeTextInput(alias);

      if (!field || !sanitizedAlias || !['song', 'artist'].includes(field)) {
        await transaction.rollback();
        return res.status(400).json({error: 'Invalid field or alias'});
      }

      // Get the original level to get the original value
      const level = await Level.findByPk(levelId);
      if (!level) {
        await transaction.rollback();
        return res.status(404).json({error: 'Level not found'});
      }

      const originalValue = level[field as 'song' | 'artist'];

      // Check if alias already exists for the current level
      const existingAlias = await LevelAlias.findOne({
        where: {
          levelId,
          field,
          originalValue,
          alias
        }
      });

      let newAlias = null;
      let propagatedCount = 0;
      let propagatedLevels: Array<Level & {id: number; [key: string]: any}> = [];

      // If alias doesn't exist for the current level, create it
      if (!existingAlias) {
        newAlias = await LevelAlias.create(
          {
            levelId,
            field,
            originalValue,
            alias,
          },
          {transaction},
        );
      } else {
        newAlias = existingAlias;
      }

      // If propagation is requested, find other levels with matching field value
      if (propagate) {
        const whereClause = {
          id: {[Op.ne]: levelId}, // Exclude the current level
          [field]:
            matchType === 'exact'
              ? originalValue
              : {[Op.like]: `%${originalValue}%`},
        };

        propagatedLevels = await Level.findAll({
          where: whereClause,
          attributes: ['id', field],
        });

        if (propagatedLevels.length > 0) {
          // Find all levels that already have this alias to avoid duplicates
          const existingAliases = await LevelAlias.findAll({
            where: {
              levelId: { [Op.in]: propagatedLevels.map(l => l.id) },
              field,
              alias
            },
            attributes: ['levelId'],
            raw: true
          });

          // Create a set of level IDs that already have this alias
          const existingAliasLevelIds = new Set(existingAliases.map(a => a.levelId));
          
          // Filter out levels that already have this alias
          const levelsToAddAlias = propagatedLevels.filter(
            level => !existingAliasLevelIds.has(level.id)
          );

          // Create aliases for levels that don't already have it
          if (levelsToAddAlias.length > 0) {
            const aliasRecords = levelsToAddAlias.map(matchingLevel => ({
              levelId: matchingLevel.id,
              field,
              originalValue: matchingLevel[field as 'song' | 'artist'],
              alias,
              createdAt: new Date(),
              updatedAt: new Date()
            }));

            // Bulk create all aliases at once
            await LevelAlias.bulkCreate(aliasRecords, { 
              transaction,
              ignoreDuplicates: true // This will ignore duplicates at the database level
            });
            
            propagatedCount = levelsToAddAlias.length;
          }
        }
      }

      await transaction.commit();

      // Return all aliases for the original level
      const aliases = await LevelAlias.findAll({
        where: {levelId},
      });

      return res.json({
        message: 'Alias(es) added successfully',
        aliases,
        propagatedCount,
        propagatedLevels: propagatedLevels.map(l => l.id),
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error adding level alias:', error);
      return res.status(500).json({error: 'Failed to add level alias'});
    }
  },
);

// Update an alias
router.put('/:levelId/aliases/:aliasId', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const levelId = parseInt(req.params.levelId);
      const aliasId = parseInt(req.params.aliasId);
      if (isNaN(levelId) || isNaN(aliasId)) {
        await transaction.rollback();
        return res.status(400).json({error: 'Invalid ID'});
      }

      const {alias} = req.body;
      // Sanitize text input
      const sanitizedAlias = sanitizeTextInput(alias);
      
      if (!sanitizedAlias) {
        await transaction.rollback();
        return res.status(400).json({error: 'Alias is required'});
      }

      const levelAlias = await LevelAlias.findOne({
        where: {
          id: aliasId,
          levelId,
        },
      });

      if (!levelAlias) {
        await transaction.rollback();
        return res.status(404).json({error: 'Alias not found'});
      }

      await levelAlias.update({alias}, {transaction});
      await transaction.commit();

      return res.json({
        message: 'Alias updated successfully',
        alias: levelAlias,
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error updating level alias:', error);
      return res.status(500).json({error: 'Failed to update level alias'});
    }
  },
);

// Delete an alias
router.delete('/:levelId/aliases/:aliasId', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const levelId = parseInt(req.params.levelId);
      const aliasId = parseInt(req.params.aliasId);
      if (isNaN(levelId) || isNaN(aliasId)) {
        await transaction.rollback();
        return res.status(400).json({error: 'Invalid ID'});
      }

      const deleted = await LevelAlias.destroy({
        where: {
          id: aliasId,
          levelId,
        },
        transaction,
      });

      if (!deleted) {
        await transaction.rollback();
        return res.status(404).json({error: 'Alias not found'});
      }

      await transaction.commit();

      return res.json({
        message: 'Alias deleted successfully',
      });
    } catch (error) {
      await transaction.rollback();
      console.error('Error deleting level alias:', error);
      return res.status(500).json({error: 'Failed to delete level alias'});
    }
  },
);

// Get count of levels that would be affected by alias propagation
router.get('/alias-propagation-count/:levelId', async (req: Request, res: Response) => {
    try {
      const {field, matchType = 'exact'} = req.query;
      const levelId = parseInt(req.params.levelId);

      if (!field || !['song', 'artist'].includes(field as string)) {
        return res.status(400).json({error: 'Invalid field'});
      }

      if (isNaN(levelId)) {
        return res.status(400).json({error: 'Invalid level ID'});
      }

      // First get the source level
      const sourceLevel = await Level.findByPk(levelId);
      if (!sourceLevel) {
        return res.status(404).json({error: 'Level not found'});
      }

      const fieldValue = sourceLevel[field as 'song' | 'artist'];
      if (!fieldValue) {
        return res.json({count: 0});
      }

      // Then count matching levels
      const whereClause = {
        id: {[Op.ne]: levelId}, // Exclude the source level
        [field as string]:
          matchType === 'exact' ? fieldValue : {[Op.like]: `%${fieldValue}%`},
      };

      const count = await Level.count({
        where: whereClause,
      });

      return res.json({
        count,
        fieldValue,
        matchType,
      });
    } catch (error) {
      console.error('Error getting alias propagation count:', error);
      return res
        .status(500)
        .json({error: 'Failed to get alias propagation count'});
    }
  },
);

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

// Add this new endpoint after the existing routes
router.put('/:id/difficulty', Auth.verified(), async (req: Request, res: Response) => {
  if (!ENABLE_ROULETTE) {
    return res.status(727).json({ error: 'April fools over, roulette is disabled' });
  }
  const transaction = await sequelize.transaction();

  try {
    const levelId = parseInt(req.params.id);
    let { diffId, baseScore, publicComments } = req.body;
    
    // Sanitize text inputs
    publicComments = sanitizeTextInput(publicComments);
    
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // if (req.user?.player?.isBanned) {
    //   return res.status(403).json({ error: 'Your account is banned' });
    // }

    const timeoutDuration = bigWheelTimeout;
    const timeout = Date.now() + timeoutDuration;
    userTimeouts.set(req.user.id, timeout);

    if (isNaN(levelId) || !Number.isInteger(levelId) || levelId <= 0) {
      return res.status(400).json({ error: 'Invalid level ID' });
    }

    if (!diffId || !Number.isInteger(diffId) || diffId <= 0) {
      return res.status(400).json({ error: 'Invalid difficulty ID' });
    }

    if (!baseScore || !Number.isInteger(baseScore) || baseScore <= 0) {
      baseScore = null;
    }

    const difficulty = await Difficulty.findByPk(diffId, { transaction });
    if (!difficulty) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Difficulty not found' });
    }

    const level = await Level.findByPk(levelId, { transaction });
    if (!level) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Level not found' });
    }

    await level.update({
      diffId: diffId,
      baseScore: baseScore,
      previousDiffId: level.diffId,
      publicComments: publicComments
    }, { transaction });

    await transaction.commit();

    // Send immediate response
    const response = {
      message: 'Level difficulty updated successfully',
      level: {
        id: level.id,
        diffId: level.diffId,
        baseScore: baseScore,
        previousDiffId: level.previousDiffId,
        publicComments: level.publicComments
      },
      timeout: timeoutDuration / 1000
    };
    res.json(response);

    // Handle pass updates asynchronously
    handlePassUpdates(levelId, diffId, baseScore);

    return;
  } catch (error) {
    await transaction.rollback();
    console.error('Error updating level difficulty:', error);
    return res.status(500).json({ error: 'Failed to update level difficulty' });
  }
});

// Add new endpoint for level timeouts
router.put('/:id/timeout', Auth.verified(), async (req: Request, res: Response) => {
  if (!ENABLE_ROULETTE) {
    return res.status(727).json({ error: 'April fools over, roulette is disabled' });
  }
  const transaction = await sequelize.transaction();
  
  try {
    const levelId = parseInt(req.params.id);
    let { diffId, baseScore, publicComments } = req.body;
    
    // Sanitize text inputs
    publicComments = sanitizeTextInput(publicComments);
    
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // if (req.user?.player?.isBanned) {
    //   return res.status(403).json({ error: 'Your account is banned' });
    // }

    const timeoutDuration = individualLevelTimeout;
    const timeout = Date.now() + timeoutDuration;
    levelTimeouts.set(levelId, timeout);

    // Update level difficulty and base score
    await Level.update(
      {
        diffId,
        baseScore: baseScore || 0,
        publicComments: publicComments
      },
      {
        where: { id: levelId },
        transaction
      }
    );

    await transaction.commit();

    // Get updated level data
    const level = await Level.findByPk(levelId, {
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
        },
      ]
    });

    // Send immediate response
    const response = {
      success: true,
      timeout: timeoutDuration / 1000,
      level: {
        id: levelId,
        diffId: level?.diffId,
        difficulty: level?.difficulty,
        baseScore: level?.baseScore,
        publicComments: level?.publicComments,
      }
    };
    res.json(response);

    // Handle pass updates asynchronously
    handlePassUpdates(levelId, diffId, baseScore);

    return;
  } catch (error) {
    await transaction.rollback();
    console.error('Error updating level timeout:', error);
    return res.status(500).json({ error: 'Failed to update level' });
  }
});


const handlePassUpdates = async (levelId: number, diffId: number, baseScore: number) => {
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


export default router;
