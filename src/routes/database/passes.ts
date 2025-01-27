import {Request, Response, Router} from 'express';
import {Op, OrderItem, Sequelize} from 'sequelize';
import {escapeRegExp} from '../../misc/Utility';
import Pass from '../../models/Pass';
import Level from '../../models/Level';
import Player from '../../models/Player';
import Judgement from '../../models/Judgement';
import {Auth} from '../../middleware/auth';
import {getIO} from '../../utils/socket';
import {calcAcc, IJudgements} from '../../misc/CalcAcc';
import {getScoreV2} from '../../misc/CalcScore';
import sequelize from '../../config/db';
import Difficulty from '../../models/Difficulty';
import {Cache} from '../../middleware/cache';
import { calculateRankedScore } from '../../misc/PlayerStatsCalculator';
import { sseManager } from '../../utils/sse';
import User from '../../models/User';
import { excludePlaceholder } from '../../middleware/excludePlaceholder';
import {PlayerStatsService} from '../../services/PlayerStatsService';
import { createMultiFieldSearchCondition, createSearchCondition } from '../../utils/searchHelpers';

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
const playerStatsService = PlayerStatsService.getInstance();

export async function updateWorldsFirstStatus(levelId: number, transaction?: any) {
  // Find the earliest non-deleted pass for this level from non-banned players
  const earliestPass = await Pass.findOne({
    where: {
      levelId,
      isDeleted: false
    },
    include: [{
      model: Player,
      as: 'player',
      where: { isBanned: false },
      required: true
    }],
    order: [['vidUploadTime', 'ASC']],
    transaction
  });

  // Reset all passes for this level to not be world's first
  await Pass.update(
    { isWorldsFirst: false },
    { 
      where: { levelId },
      transaction
    }
  );

  // If we found an earliest pass, mark it as world's first
  if (earliestPass) {
    await Pass.update(
      { isWorldsFirst: true },
      { 
        where: { id: earliestPass.id },
        transaction
      }
    );
  }
}

const difficultyNameToSortOrder: { [key: string]: number } = {
  'P1': 1, 'P2': 3, 'P3': 4, 'P4': 5, 'P5': 6,
  'P6': 7, 'P7': 8, 'P8': 9, 'P9': 10, 'P10': 11,
  'P11': 12, 'P12': 13, 'P13': 14, 'P14': 15, 'P15': 16,
  'P16': 17, 'P17': 18, 'P18': 18.5, 'P19': 19, 'P20': 19.5,
  'G1': 20, 'G2': 20.05, 'G3': 20.1, 'G4': 20.15, 'G5': 20.2,
  'G6': 20.25, 'G7': 20.3, 'G8': 20.35, 'G9': 20.4, 'G10': 20.45,
  'G11': 20.5, 'G12': 20.55, 'G13': 20.6, 'G14': 20.65, 'G15': 20.7,
  'G16': 20.75, 'G17': 20.8, 'G18': 20.85, 'G19': 20.9, 'G20': 20.95,
  'U1': 21, 'U2': 21.04, 'U3': 21.05, 'U4': 21.09, 'U5': 21.1,
  'U6': 21.14, 'U7': 21.15, 'U8': 21.19, 'U9': 21.2, 'U10': 21.24,
  'U11': 21.25, 'U12': 21.29, 'U13': 21.3, 'U14': 21.34, 'U15': 21.35,
  'U16': 21.39, 'U17': 21.4, 'U18': 21.44, 'U19': 21.45, 'U20': 21.49
};

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
      exact: true
    };
  }

  // Check for partial match with colon
  const partialMatch = trimmedTerm.match(/^(video|player):(.+)$/i);
  if (partialMatch) {
    return {
      field: partialMatch[1].toLowerCase(),
      value: partialMatch[2].trim(),
      exact: false
    };
  }

  return null;
};

// Helper function to parse the entire search query
const parseSearchQuery = (query: string): SearchGroup[] => {
  if (!query) return [];
  
  // Split by | for OR groups and handle trimming here
  const groups = query.split('|').map(group => {
    // Split by comma for AND terms within each group
    const terms = group.split(',')
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
          exact: false
        };
      });

    return {
      terms,
      operation: 'AND' as const
    };
  }).filter(group => group.terms.length > 0); // Remove empty groups

  return groups;
};

// Helper function to build field-specific search condition
const buildFieldSearchCondition = async (fieldSearch: FieldSearch): Promise<any> => {
  const { field, value, exact } = fieldSearch;
  
  // Handle special characters in the search value
  const searchValue = exact ? 
    value : 
    `%${value.replace(/(_|%|\\)/g, '\\$1')}%`;

  // Create the base search condition
  const searchCondition = { [exact ? Op.eq : Op.like]: searchValue };

  // For field-specific searches
  if (field === 'video') {
    return { videoLink: searchCondition };
  }
  
  if (field === 'player') {
    return sequelize.where(
      sequelize.fn('LOWER', sequelize.col('player.name')),
      exact ? Op.eq : Op.like,
      sequelize.fn('LOWER', searchValue)
    );
  }

  // For general searches (field === 'any')
  return {
    [Op.or]: [
      sequelize.where(
        sequelize.fn('LOWER', sequelize.col('player.name')),
        Op.like,
        sequelize.fn('LOWER', `%${value}%`)
      ),
      { videoLink: { [Op.like]: `%${value}%` } }
    ]
  };
};

// Build where clause
const buildWhereClause = async (query: any) => {
  const where: any = {};
  const conditions: any[] = [];

  // Handle deleted filter
  if (query.deletedFilter === 'hide') {
    conditions.push({isDeleted: false});
  } else if (query.deletedFilter === 'only') {
    conditions.push({isDeleted: true});
  }

  // Handle key flag filter
  if (query.keyFlag) {
    switch (query.keyFlag) {
      case '12k':
        conditions.push({ is12K: true });
        break;
      case '16k':
        conditions.push({ is16K: true });
        break;
      // 'all' case doesn't need a condition as it means no filtering
    }
  }

  // Handle text search with new parsing
  if (query.query) {
    const searchGroups = parseSearchQuery(query.query.trim());
    
    if (searchGroups.length > 0) {
      const orConditions = await Promise.all(
        searchGroups.map(async group => {
          const andConditions = await Promise.all(
            group.terms.map(term => buildFieldSearchCondition(term))
          );
          
          return andConditions.length === 1 
            ? andConditions[0] 
            : { [Op.and]: andConditions };
        })
      );

      conditions.push(
        orConditions.length === 1 
          ? orConditions[0] 
          : { [Op.or]: orConditions }
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
  switch (sort) {
    case 'RECENT_ASC':
      return [['vidUploadTime', 'ASC']];
    case 'RECENT_DESC':
      return [['vidUploadTime', 'DESC']];
    case 'SCORE_ASC':
      return [
        ['scoreV2', 'ASC'],
        ['id', 'DESC'], // Secondary sort by newest first
      ];
    case 'SCORE_DESC':
      return [
        ['scoreV2', 'DESC'],
        ['id', 'DESC'], // Secondary sort by newest first
      ];
    case 'XACC_ASC':
      return [
        ['accuracy', 'ASC'],
        ['scoreV2', 'DESC'], // Secondary sort by highest score
        ['id', 'DESC'], // Tertiary sort by newest first
      ];
    case 'XACC_DESC':
      return [
        ['accuracy', 'DESC'],
        ['scoreV2', 'DESC'], // Secondary sort by highest score
        ['id', 'DESC'], // Tertiary sort by newest first
      ];
    case 'DIFF_ASC':
      return [
        [{model: Level, as: 'level'}, 'diffId', 'ASC'],
        ['scoreV2', 'DESC'], // Secondary sort by highest score
        ['id', 'DESC'], // Tertiary sort by newest first
      ];
    case 'DIFF_DESC':
      return [
        [{model: Level, as: 'level'}, 'diffId', 'DESC'],
        ['scoreV2', 'DESC'], // Secondary sort by highest score
        ['id', 'DESC'], // Tertiary sort by newest first
      ];
    case 'RANDOM':
      return [sequelize.random()];
    default:
      return [
        ['scoreV2', 'DESC'], // Default to highest score
        ['id', 'DESC'], // Secondary sort by newest first
      ];
  }
};

router.get('/level/:levelId', async (req: Request, res: Response) => {
  try {
    const {levelId} = req.params;

    const passes = await Pass.findAll({
      where: {
        levelId: parseInt(levelId),
        isDeleted: false,
        '$player.isBanned$': false,
      },
      include: [
        {
          model: Player,
          as: 'player',
          include: [
            {
              model: User,
              as: 'user',
              attributes: ['id', 'username', 'nickname', 'avatarUrl', 'isSuperAdmin', 'isRater'],
            },
          ],
        },
        {
          model: Judgement,
          as: 'judgements',
        },
      ],
    });

    return res.json(passes);
  } catch (error) {
    console.error('Error fetching passes:', error);
    return res.status(500).json({error: 'Failed to fetch passes'});
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      deletedFilter,
      minDiff,
      maxDiff,
      keyFlag,
      levelId,
      player,
      query: searchQuery,
      offset = 0,
      limit = 30,
      sort
    } = req.body;

    const where = await buildWhereClause({
      deletedFilter,
      minDiff,
      maxDiff,
      keyFlag,
      levelId,
      player,
      query: searchQuery
    });

    const order = getSortOptions(sort);
    // First get all IDs in correct order
    const allIds = await Pass.findAll({
      where,
      include: [
        {
          model: Player,
          as: 'player',
          where: { isBanned: false },
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

    // Then get paginated results using those IDs in their original order
    const paginatedIds = allIds
      .map((pass: any) => pass.id)
      .slice(offset, offset + limit);

    const results = await Pass.findAll({
      where: {
        id: {
          [Op.in]: paginatedIds,
        },
      },
      include: [
        {
          model: Player,
          as: 'player',
          attributes: ['name', 'country', 'isBanned'],
          where: { isBanned: false },
          required: true,
        },
        {
          model: Level,
          as: 'level',
          where: { isHidden: false },
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

    return res.json({
      count: allIds.length,
      results,
    });
  } catch (error) {
    console.error('Error fetching passes:', error);
    return res.status(500).json({error: 'Failed to fetch passes'});
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const passId = parseInt(req.params.id);
    if (!passId || isNaN(passId)) {
      return res.status(400).json({ error: 'Invalid pass ID' });
    }

    const pass = await playerStatsService.getPassDetails(passId);
    if (!pass) {
      return res.status(404).json({ error: 'Pass not found' });
    }

    return res.json(pass);
  } catch (error) {
    console.error('Error fetching pass:', error);
    return res.status(500).json({
      error: 'Failed to fetch pass',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

router.put('/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const {id} = req.params;
    const {
      vidUploadTime,
      speed,
      feelingRating,
      vidTitle,
      videoLink,
      is12K,
      is16K,
      isNoHoldTap,
      isWorldsFirst,
      accuracy,
      scoreV2,
      isDeleted,
      judgements
    } = req.body;

    // Update pass
    const pass = await Pass.findOne({
      where: {id: parseInt(id)},
      include: [
        {
          model: Level,
          as: 'level',
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              attributes: ['baseScore'],
            },
          ],
        },
        {
          model: Player,
          as: 'player',
        },
        {
          model: Judgement,
          as: 'judgements',
        },
      ],
      transaction,
    });

    if (!pass) {
      await transaction.rollback();
      return res.status(404).json({error: 'Pass not found'});
    }

    // Update judgements if provided
    if (judgements) {
      await Judgement.update({
        earlyDouble: judgements.earlyDouble,
        earlySingle: judgements.earlySingle,
        ePerfect: judgements.ePerfect,
        perfect: judgements.perfect,
        lPerfect: judgements.lPerfect,
        lateSingle: judgements.lateSingle,
        lateDouble: judgements.lateDouble,
      }, {
        where: {id: parseInt(id)},
        transaction,
      });

      // Recalculate accuracy and score
      const updatedJudgements: IJudgements = {
        earlyDouble: judgements.earlyDouble,
        earlySingle: judgements.earlySingle,
        ePerfect: judgements.ePerfect,
        perfect: judgements.perfect,
        lPerfect: judgements.lPerfect,
        lateSingle: judgements.lateSingle,
        lateDouble: judgements.lateDouble,
      };

      const calculatedAccuracy = calcAcc(updatedJudgements);
      
      // Create pass data for score calculation with proper type handling
      const passData = {
        speed: pass.speed || 1.0, // Default to 1.0 if null
        judgements: updatedJudgements,
        isNoHoldTap: pass.isNoHoldTap || false // Default to false if null
      } as const;

      // Check if level exists before calculating score
      if (!pass.level) {
        await transaction.rollback();
        return res.status(500).json({error: 'Level data not found for pass'});
      }

      if (!pass.level.difficulty) {
        await transaction.rollback();
        return res.status(500).json({error: 'Difficulty data not found for pass'});
      }

      // Create properly structured level data for score calculation
      const levelData = {
        baseScore: pass.level.baseScore,
        difficulty: pass.level.difficulty
      };

      const calculatedScore = getScoreV2(passData, levelData);

      // Update pass fields with calculated values
      await pass.update({
        vidUploadTime: vidUploadTime || pass.vidUploadTime,
        speed: speed || pass.speed,
        feelingRating: feelingRating !== undefined ? feelingRating : pass.feelingRating,
        vidTitle: vidTitle !== undefined ? vidTitle : pass.vidTitle,
        videoLink: videoLink !== undefined ? videoLink : pass.videoLink,
        is12K: is12K !== undefined ? is12K : pass.is12K,
        is16K: is16K !== undefined ? is16K : pass.is16K,
        isNoHoldTap: isNoHoldTap !== undefined ? isNoHoldTap : pass.isNoHoldTap,
        isWorldsFirst: isWorldsFirst !== undefined ? isWorldsFirst : pass.isWorldsFirst,
        accuracy: calculatedAccuracy,
        scoreV2: calculatedScore,
        isDeleted: isDeleted !== undefined ? isDeleted : pass.isDeleted,
      }, {transaction});
    } else {
      // Update pass fields without recalculating if no judgements provided
      await pass.update({
        vidUploadTime: vidUploadTime || pass.vidUploadTime,
        speed: speed || pass.speed,
        feelingRating: feelingRating !== undefined ? feelingRating : pass.feelingRating,
        vidTitle: vidTitle !== undefined ? vidTitle : pass.vidTitle,
        videoLink: videoLink !== undefined ? videoLink : pass.videoLink,
        is12K: is12K !== undefined ? is12K : pass.is12K,
        is16K: is16K !== undefined ? is16K : pass.is16K,
        isNoHoldTap: isNoHoldTap !== undefined ? isNoHoldTap : pass.isNoHoldTap,
        isWorldsFirst: isWorldsFirst !== undefined ? isWorldsFirst : pass.isWorldsFirst,
        accuracy: accuracy !== undefined ? accuracy : pass.accuracy,
        scoreV2: scoreV2!== undefined ? scoreV2 : pass.scoreV2,
        isDeleted: isDeleted !== undefined ? isDeleted : pass.isDeleted,
      }, {transaction});
    }

    // Fetch the updated pass
    const updatedPass = await Pass.findOne({
      where: {id: parseInt(id)},
      include: [
        {
          model: Level,
          as: 'level',
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
        {
          model: Player,
          as: 'player',
          attributes: ['id', 'name', 'country', 'isBanned'],
        },
      ],
      transaction,
    });

    await transaction.commit();

    // Update player stats
    if (pass.player) {
      await playerStatsService.updatePlayerStats(pass.player.id);
    }

    const io = getIO();
    io.emit('leaderboardUpdated');

    // Get player's new stats
    if (updatedPass && updatedPass.player) {
      const playerStats = await playerStatsService.getPlayerStats(updatedPass.player.id);

      // Emit SSE event with pass update data
      sseManager.broadcast({
        type: 'passUpdate',
        data: {
          playerId: updatedPass.player.id,
          passedLevelId: updatedPass.levelId,
          newScore: playerStats?.rankedScore || 0,
          action: 'update',
        },
      });
    }

    return res.json(updatedPass);
  } catch (error) {
    await transaction.rollback();
    console.error('Error updating pass:', error);
    return res.status(500).json({
      error: 'Failed to update pass',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

router.delete('/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const {id} = req.params;

    const pass = await Pass.findOne({
      where: {id: parseInt(id)},
      include: [
        {
          model: Level,
          as: 'level',
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
            },
          ],
        },
        {
          model: Player,
          as: 'player',
          attributes: ['id', 'name', 'country', 'isBanned'],
        },
        {
          model: Judgement,
          as: 'judgements',
        },
      ],
      transaction,
    });

    if (!pass) {
      await transaction.rollback();
      return res.status(404).json({error: 'Pass not found'});
    }

    // Store levelId and playerId before deleting
    const levelId = pass.levelId;
    const playerId = pass.player?.id;

    // Soft delete the pass
    await Pass.update(
      { isDeleted: true },
      {
        where: { id: parseInt(id) },
        transaction,
      }
    );

    // Update world's first status for this level
    await updateWorldsFirstStatus(levelId, transaction);

    // Update level clear count
    await Level.decrement('clears', {
      where: {id: pass.levelId},
      transaction,
    });

    // If this was the last clear, update isCleared status
    const remainingClears = await Pass.count({
      where: {
        levelId: pass.levelId,
        isDeleted: false,
      },
      transaction,
    });

    if (remainingClears === 0) {
      await Level.update(
        {isCleared: false},
        {
          where: {id: pass.levelId},
          transaction,
        },
      );
    }

    // Reload the pass to get updated data
    await pass.reload({
      include: [
        {
          model: Level,
          as: 'level',
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
            },
          ],
        },
        {
          model: Player,
          as: 'player',
          attributes: ['id', 'name', 'country', 'isBanned'],
        },
        {
          model: Judgement,
          as: 'judgements',
        },
      ],
      transaction,
    });

    await transaction.commit();

    // Update player stats
    if (playerId) {
      await playerStatsService.updatePlayerStats(playerId);
    }

    const io = getIO();
    io.emit('leaderboardUpdated');
    io.emit('passesUpdated');

    // Get player's new stats and emit SSE event
    if (playerId) {
      const playerStats = await playerStatsService.getPlayerStats(playerId);

      sseManager.broadcast({
        type: 'passUpdate',
        data: {
          playerId,
          passedLevelId: levelId,
          newScore: playerStats?.rankedScore || 0,
          action: 'delete'
        }
      });
    }

    return res.json({
      message: 'Pass soft deleted successfully',
      pass: pass,
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error soft deleting pass:', error);
    return res.status(500).json({error: 'Failed to soft delete pass'});
  }
});

router.patch('/:id/restore', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const {id} = req.params;

    const pass = await Pass.findOne({
      where: {id: parseInt(id)},
      include: [
        {
          model: Level,
          as: 'level',
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
            },
          ],
        },
        {
          model: Player,
          as: 'player',
          attributes: ['id', 'name', 'country', 'isBanned'],
        },
      ],
      transaction,
    });

    if (!pass) {
      await transaction.rollback();
      return res.status(404).json({error: 'Pass not found'});
    }

    // Store levelId and playerId
    const levelId = pass.levelId;
    const playerId = pass.player?.id;

    // Restore the pass
    await Pass.update(
      { isDeleted: false },
      {
        where: { id: parseInt(id) },
        transaction,
      }
    );

    // Update world's first status for this level
    await updateWorldsFirstStatus(levelId, transaction);

    // Update level clear count and status
    await Promise.all([
      Level.increment('clears', {
        where: {id: pass.levelId},
        transaction,
      }),
      Level.update(
        {isCleared: true},
        {
          where: {id: pass.levelId},
          transaction,
        },
      ),
    ]);

    await transaction.commit();

    // Update player stats
    if (playerId) {
      await playerStatsService.updatePlayerStats(playerId);
    }

    const io = getIO();
    io.emit('leaderboardUpdated');
    io.emit('passesUpdated');

    // Get player's new stats and emit SSE event
    if (playerId) {
      const playerStats = await playerStatsService.getPlayerStats(playerId);

      sseManager.broadcast({
        type: 'passUpdate',
        data: {
          playerId,
          passedLevelId: levelId,
          newScore: playerStats?.rankedScore || 0,
          action: 'restore'
        }
      });
    }

    return res.json({
      message: 'Pass restored successfully',
      pass: pass,
    });
  } catch (error) {
    await transaction.rollback();
    console.error('Error restoring pass:', error);
    return res.status(500).json({error: 'Failed to restore pass'});
  }
});

// Add new route for getting pass by ID as a list
router.get('/byId/:id', excludePlaceholder.fromResponse(), async (req: Request, res: Response) => {
  try {
    const passId = parseInt(req.params.id);
    if (!passId || isNaN(passId) || passId <= 0) {
      return res.status(400).json({ error: 'Invalid pass ID' });
    }

    const pass = await Pass.findOne({
      where: {
        id: passId,
        isDeleted: false,
      },
      include: [
        {
          model: Player,
          as: 'player',
          attributes: ['name', 'country', 'isBanned'],
          where: { isBanned: false },
          required: true,
        },
        {
          model: Level,
          as: 'level',
          required: true,
          attributes: ['song', 'artist', 'baseScore'],
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              required: true,
            },
          ],
        },
        {
          model: Judgement,
          as: 'judgements',
          required: false,
        },
      ],
    });

    if (!pass) {
      return res.json({count: 0, results: []});
    }

    return res.json({count: 1, results: [pass]});
  } catch (error) {
    console.error('Error fetching pass by ID:', error);
    return res.status(500).json({error: 'Failed to fetch pass'});
  }
});

// Get unannounced passes
router.get('/unannounced/new', async (req: Request, res: Response) => {
  try {
    const passes = await Pass.findAll({
      where: {
        isAnnounced: false,
        isDeleted: false,
      },
      include: [
        {
          model: Player,
          as: 'player',
          attributes: ['name', 'country', 'isBanned'],
          where: { isBanned: false },
          required: true,
        },
        {
          model: Level,
          as: 'level',
          required: true,
          include: [
            {
              model: Difficulty,
              as: 'difficulty',
              required: true,
            },
          ],
        },
        {
          model: Judgement,
          as: 'judgements',
          required: false,
        },
      ],
      order: [['updatedAt', 'DESC']]
    });

    return res.json(passes);
  } catch (error) {
    console.error('Error fetching unannounced passes:', error);
    return res.status(500).json({ error: 'Failed to fetch unannounced passes' });
  }
});

// Mark passes as announced
router.post('/announce', async (req: Request, res: Response) => {
  try {
    const { passIds } = req.body;
    
    if (!Array.isArray(passIds) || !passIds.every(id => Number.isInteger(id) && id > 0)) {
      return res.status(400).json({ error: 'passIds must be an array of valid IDs' });
    }

    await Pass.update(
      { isAnnounced: true },
      {
        where: {
          id: {
            [Op.in]: passIds
          },
          isDeleted: false
        }
      }
    );

    return res.json({ success: true, message: 'Passes marked as announced' });
  } catch (error) {
    console.error('Error marking passes as announced:', error);
    return res.status(500).json({ error: 'Failed to mark passes as announced' });
  }
});

// Mark a single pass as announced
router.post('/markAnnounced/:id', async (req: Request, res: Response) => {
  try {
    const passId = parseInt(req.params.id);
    if (!passId || isNaN(passId) || passId <= 0) {
      return res.status(400).json({ error: 'Invalid pass ID' });
    }

    const pass = await Pass.findOne({
      where: {
        id: passId,
        isDeleted: false
      }
    });
    
    if (!pass) {
      return res.status(404).json({ error: 'Pass not found' });
    }

    await pass.update({ isAnnounced: true });
    return res.json({ success: true });
  } catch (error) {
    console.error('Error marking pass as announced:', error);
    return res.status(500).json({ 
      error: 'Failed to mark pass as announced',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Helper function to ensure string type
const ensureString = (value: any): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0]?.toString();
  if (value?.toString) return value.toString();
  return undefined;
};

// Main GET endpoint with search
router.get('/', excludePlaceholder.fromResponse(), async (req: Request, res: Response) => {
  try {
    const {
      deletedFilter,
      minDiff,
      maxDiff,
      keyFlag,
      levelId,
      player,
      query: searchQuery,
      offset = '0',
      limit = '30',
      sort
    } = req.query;

    const where = await buildWhereClause({
      deletedFilter: ensureString(deletedFilter),
      minDiff: ensureString(minDiff),
      maxDiff: ensureString(maxDiff),
      keyFlag: ensureString(keyFlag),
      levelId: ensureString(levelId),
      player: ensureString(player),
      query: ensureString(searchQuery)
    });

    const order = getSortOptions(ensureString(sort));
    // First get all IDs in correct order
    const allIds = await Pass.findAll({
      where,
      include: [
        {
          model: Player,
          as: 'player',
          where: { isBanned: false },
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

    // Then get paginated results using those IDs in their original order
    const offsetNum = Math.max(0, Number(ensureString(offset)) || 0);
    const limitNum = Math.max(1, Math.min(100, Number(ensureString(limit)) || 30));
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
          where: { isBanned: false },
          required: true,
        },
        {
          model: Level,
          as: 'level',
          where: { isHidden: false },
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

    return res.json({
      count: allIds.length,
      results,
    });
  } catch (error) {
    console.error('Error fetching passes:', error);
    return res.status(500).json({error: 'Failed to fetch passes'});
  }
});

export default router;
