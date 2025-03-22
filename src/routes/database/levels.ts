import {Op, Order, OrderItem, literal, Transaction} from 'sequelize';
import Level from '../../models/Level.js';
import Pass from '../../models/Pass.js';
import Rating from '../../models/Rating.js';
import Player from '../../models/Player.js';
import Judgement from '../../models/Judgement.js';
import {Auth} from '../../middleware/auth.js';
import {getIO} from '../../utils/socket.js';
import sequelize from '../../config/db.js';
import RatingDetail from '../../models/RatingDetail.js';
import Difficulty from '../../models/Difficulty.js';
import {sseManager} from '../../utils/sse.js';
import {getScoreV2} from '../../misc/CalcScore.js';
import {calcAcc} from '../../misc/CalcAcc.js';
import Team from '../../models/Team.js';
import Creator from '../../models/Creator.js';
import LevelCredit from '../../models/LevelCredit.js';
import LevelAlias from '../../models/LevelAlias.js';
import {PlayerStatsService} from '../../services/PlayerStatsService.js';
import {Router, Request, Response} from 'express';
import { escapeForMySQL } from '../../utils/searchHelpers.js';
const router: Router = Router();
const playerStatsService = PlayerStatsService.getInstance();

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
  const exactMatch = trimmedTerm.match(/^(song|artist|charter)=(.+)$/i);
  if (exactMatch) {
    return {
      field: exactMatch[1].toLowerCase(),
      value: exactMatch[2].trim(),
      exact: true,
    };
  }

  // Check for partial match with colon
  const partialMatch = trimmedTerm.match(/^(song|artist|charter):(.+)$/i);
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

// Get all levels with filtering and pagination
router.get('/', async (req: Request, res: Response) => {
  try {
    const where = await buildWhereClause(req.query);
    const sort = req.query.sort as string;
    const isRandomSort = sort === 'RANDOM';
    const order = getSortOptions(sort);

    // For random sorting, we'll use a different approach to ensure consistent pagination
    if (isRandomSort) {
      // First, get all matching IDs
      const allIds = await Level.findAll({
        where,
        attributes: ['id'],
        raw: true,
      });

      // Generate a random seed based on the current hour to maintain consistency for a period
      const now = new Date();
      let seedValue =
        now.getFullYear() * 10000 +
        (now.getMonth() + 1) * 100 +
        now.getDate() +
        now.getHours();

      // Use the seed to shuffle the array consistently
      const shuffledIds = allIds
        .map(level => level.id)
        .sort(() => {
          const x = Math.sin(seedValue++) * 10000;
          return x - Math.floor(x);
        });

      // Get the paginated slice of IDs
      const offset = parseInt(req.query.offset as string) || 0;
      const limit = parseInt(req.query.limit as string) || 30;
      const paginatedIds = shuffledIds.slice(offset, offset + limit);

      // Fetch the actual levels
      const results = await Level.findAll({
        where: {
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
            attributes: ['id'],
          },
        ],
        // Use FIELD function to maintain the shuffled order
        order: [
          [literal(`FIELD(id, ${paginatedIds.join(',')})`), 'ASC'],
        ] as OrderItem[],
      });

      return res.json({
        count: allIds.length,
        results,
      });
    }

    // For non-random sorting
    const allIds = await Level.findAll({
      where,
      include: [
        {
          model: Difficulty,
          as: 'difficulty',
          required: false,
        },
      ],
      order,
      attributes: ['id'],
      raw: true,
    });

    const offset = parseInt(req.query.offset as string) || 0;
    const limit = parseInt(req.query.limit as string) || 30;
    const paginatedIds = allIds
      .map(level => level.id)
      .slice(offset, offset + limit);

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
          model: Team,
          as: 'teamObject',
          required: false,
        }
      ],
      order,
    });

    return res.json({
      count: allIds.length,
      results,
    });
  } catch (error) {
    console.error('Error fetching levels:', error);
    return res.status(500).json({error: 'Failed to fetch levels'});
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
          where: {levelId},
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
            },
            {transaction},
          );
        }
      } else {
        // Delete rating if toRate is being set to false
        const existingRating = await Rating.findOne({
          where: {levelId},
          transaction,
        });

        if (existingRating) {
          // Delete rating details first
          await RatingDetail.destroy({
            where: {ratingId: existingRating.id},
            transaction,
          });
          // Then delete the rating
          await existingRating.destroy({transaction});
        }
      }
    }

    // Update lowDiff flag if there's an existing rating
    const existingRating = await Rating.findOne({
      where: {levelId},
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
      previousDiffId === req.body.diffId
        ? level.previousDiffId
        : previousDiffId;
    // Clean up the update data to handle null values correctly
    const updateData = {
      song: req.body.song,
      artist: req.body.artist,
      creator: req.body.creator,
      charter: req.body.charter,
      vfxer: req.body.vfxer,
      team: req.body.team,
      diffId: req.body.diffId || 0,
      previousDiffId,
      baseScore:
        req.body.baseScore === ''
          ? null
          : (req.body.baseScore ?? level.baseScore),
      videoLink: req.body.videoLink,
      dlLink: req.body.dlLink || null,
      workshopLink: req.body.workshopLink,
      publicComments: req.body.publicComments,
      rerateNum: req.body.rerateNum,
      toRate: req.body.toRate ?? level.toRate,
      rerateReason: req.body.rerateReason,
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
            affectedPlayerIds.forEach(playerId => {
              playerStatsService.scheduleUpdate(playerId);
            });
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
router.put('/:id/toRate', async (req: Request, res: Response) => {
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
      where: {levelId},
      transaction,
    });

    if (existingRating) {
      // If rating exists, delete all associated details first
      await RatingDetail.destroy({
        where: {ratingId: existingRating.id},
        transaction,
      });

      // Then delete the rating and update level
      await existingRating.destroy({transaction});

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

router.delete(
  '/:id',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
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
          affectedPlayerIds.forEach(playerId => {
            playerStatsService.scheduleUpdate(playerId);
          });


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

router.patch(
  '/:id/restore',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
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
router.get('/unannounced/new', async (req: Request, res: Response) => {
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
router.get('/unannounced/rerates', async (req: Request, res: Response) => {
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
router.post('/announce', async (req: Request, res: Response) => {
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
router.post('/markAnnounced/:id', async (req: Request, res: Response) => {
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
router.patch(
  '/:id/toggle-hidden',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
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

// Add the new filtering endpoint
router.post('/filter', async (req: Request, res: Response) => {
  try {
    const {pguRange, specialDifficulties} = req.body;
    const {query, sort, offset, limit, deletedFilter, clearedFilter} =
      req.query;

    // Build the base where clause using the shared function
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
    if (specialDifficulties?.length > 0) {
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
      ],
      order,
      attributes: ['id'],
      raw: true,
    });

    // Then get paginated results
    const paginatedIds = allIds
      .map(level => level.id)
      .slice(
        Number(offset) || 0,
        (Number(offset) || 0) + (Number(limit) || 30),
      );

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
          model: Team,
          as: 'teamObject',
          required: false,
        }
      ],
      order,
    });

    return res.json({
      count: allIds.length,
      results,
    });
  } catch (error) {
    console.error('Error filtering levels:', error);
    return res.status(500).json({error: 'Failed to filter levels'});
  }
});

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
router.post(
  '/:id/aliases',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const levelId = parseInt(req.params.id);
      if (isNaN(levelId)) {
        await transaction.rollback();
        return res.status(400).json({error: 'Invalid level ID'});
      }

      const {field, alias, matchType = 'exact', propagate = false} = req.body;

      if (!field || !alias || !['song', 'artist'].includes(field)) {
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

      // Create alias for the current level
      await LevelAlias.create(
        {
          levelId,
          field,
          originalValue,
          alias,
        },
        {transaction},
      );

      let propagatedCount = 0;
      let propagatedLevels: Array<Level & {id: number; [key: string]: any}> =
        [];

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
          // Create the aliases one by one to ensure they're all created
          for (const matchingLevel of propagatedLevels) {
            try {
              await LevelAlias.create(
                {
                  levelId: matchingLevel.id,
                  field,
                  originalValue: matchingLevel[field as 'song' | 'artist'],
                  alias,
                },
                {
                  transaction,
                },
              );
              propagatedCount++;
            } catch (err) {
              console.error(
                `Failed to create alias for level ${matchingLevel.id}:`,
                err,
              );
              // Continue with other levels even if one fails
            }
          }
        }
      }

      await transaction.commit();

      // Return all created/updated aliases for the original level
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
router.put(
  '/:levelId/aliases/:aliasId',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();

    try {
      const levelId = parseInt(req.params.levelId);
      const aliasId = parseInt(req.params.aliasId);
      if (isNaN(levelId) || isNaN(aliasId)) {
        await transaction.rollback();
        return res.status(400).json({error: 'Invalid ID'});
      }

      const {alias} = req.body;
      if (!alias) {
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
router.delete(
  '/:levelId/aliases/:aliasId',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
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
router.get(
  '/alias-propagation-count/:levelId',
  async (req: Request, res: Response) => {
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

export default router;
