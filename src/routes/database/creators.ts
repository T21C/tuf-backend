import {Op, where, WhereOptions} from 'sequelize';
import {Auth} from '../../middleware/auth.js';
import Creator from '../../models/credits/Creator.js';
import Level from '../../models/levels/Level.js';
import LevelCredit from '../../models/levels/LevelCredit.js';
import {CreditRole} from '../../models/levels/LevelCredit.js';
import sequelize from '../../config/db.js';
import Team from '../../models/credits/Team.js';
import TeamMember from '../../models/credits/TeamMember.js';
import {excludePlaceholder} from '../../middleware/excludePlaceholder.js';
import User from '../../models/auth/User.js';
import {
  createMultiFieldSearchCondition,
  createSearchCondition,
  escapeForMySQL,
} from '../../utils/searchHelpers.js';
import {Router, Request, Response} from 'express';
import LevelSubmissionCreatorRequest from '../../models/submissions/LevelSubmissionCreatorRequest.js';
import { CreatorAlias } from '../../models/credits/CreatorAlias.js';
import { TeamAlias } from '../../models/credits/TeamAlias.js';
import { buildWhereClause, filterLevels } from './levels/index.js';
import { logger } from '../../services/LoggerService.js';
const router: Router = Router();

interface LevelCountResult {
  creatorId: number;
  count: string;
}

const MAX_LIMIT = 500;


// Get all creators with their aliases and level counts
router.get('/', excludePlaceholder.fromResponse(), async (req: Request, res: Response) => {
    try {
      const {
        page = '1',
        limit = '100',
        search = '',
        hideVerified = 'false',
        excludeAliases = 'false',
        sort = 'NAME_ASC',
      } = req.query;

      const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
      const normalizedLimit = Math.max(1, Math.min(MAX_LIMIT, parseInt(limit as string)));
      
      const where: any = {};
      if (hideVerified === 'true') {
        where.isVerified = false;
      }

      const escapedSearch = escapeForMySQL(search as string);
      // Build order clause
      let order: any[] = [['name', 'ASC']]; // default sorting
      switch (sort) {
        case 'NAME_DESC':
          order = [['name', 'DESC']];
          break;
        case 'ID_ASC':
          order = [['id', 'ASC']];
          break;
        case 'ID_DESC':
          order = [['id', 'DESC']];
          break;
        case 'CHARTS_ASC':
          order = [
            [
              sequelize.literal(
                '(SELECT COUNT(*) FROM level_credits WHERE level_credits.creatorId = Creator.id)',
              ),
              'ASC',
            ],
          ];
          break;
        case 'CHARTS_DESC':
          order = [
            [
              sequelize.literal(
                '(SELECT COUNT(*) FROM level_credits WHERE level_credits.creatorId = Creator.id)',
              ),
              'DESC',
            ],
          ];
          break;
      }

      const creatorsByName = await Creator.findAll({
        where: {name: {[Op.like]: `%${escapedSearch}%`}},
        attributes: ['id'],
      });

      const creatorsByAlias = await CreatorAlias.findAll({
        where: {name: {[Op.like]: `%${escapedSearch}%`}},
        attributes: ['creatorId'],
      });

      const creatorIds: Set<number> = new Set(creatorsByName.map(creator => creator.id));
      if (excludeAliases !== 'true') {
        creatorsByAlias.forEach(alias => creatorIds.add(alias.creatorId));
      }
      
      logger.debug(`Total by id for ${escapedSearch}: ${creatorIds.size}`);
      // Then get paginated results
      const {rows: creators, count: totalCount} = await Creator.findAndCountAll({
        where: {id: {[Op.in]: Array.from(creatorIds)}},
        include: [
          {
            model: Level,
            as: 'createdLevels',
            through: {attributes: ['role']},
            attributes: ['id'],
          },
          {
            model: User,
            as: 'user',
            attributes: ['id', 'username', 'avatarUrl'],
          },
          {
            model: CreatorAlias,
            as: 'creatorAliases',
            attributes: ['id', 'name'],
          },
        ],
        order,
        offset,
        limit: normalizedLimit,
      });

      return res.json({
        count: totalCount,
        results: creators,
      });
    } catch (error) {
      logger.error('Error fetching creators:', error);
      return res.status(500).json({error: 'Failed to fetch creators'});
    }
  },
);

router.get('/byId/:creatorId([0-9]+)', async (req: Request, res: Response) => {
  try {
    const {creatorId} = req.params;
    const creator = await Creator.findByPk(creatorId, {
      include: [
        {
          model: Level,
          as: 'createdLevels',
          attributes: ['id', 'isVerified'],
        },
        {
          model: LevelCredit,
          as: 'credits',
          attributes: ['id', 'role', 'levelId'],
        },
        {
          model: CreatorAlias,
          as: 'creatorAliases',
          attributes: ['id', 'name'],
        }
      ],
    });

    if (!creator) {
      return res.status(404).json({ error: 'Creator not found' });
    }

    return res.json(creator);
  } catch (error) {
    logger.error('Error fetching creator:', error);
    return res.status(500).json({ error: 'Failed to fetch creator details' });
  }
}); 

// Get team by ID with members and levels
router.get('/teams/byId/:teamId([0-9]+)', async (req: Request, res: Response) => {
  try {
    const {teamId} = req.params;
    const team = await Team.findByPk(teamId, {
      include: [
        {
          model: Creator,
          as: 'members',
          through: { attributes: [] }
        },
        {
          model: Level,
          as: 'levels',
          attributes: ['id', 'isVerified']
        }
      ],
    });

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    return res.json(team);
  } catch (error) {
    logger.error('Error fetching team:', error);
    return res.status(500).json({ error: 'Failed to fetch team details' });
  }
});

// Get levels with their legacy and current creators
router.get('/levels-audit', excludePlaceholder.fromResponse(), async (req: Request, res: Response) => {
    try {
      const offset = parseInt(req.query.offset as string) || 0;
      const limit = parseInt(req.query.limit as string) || 50;
      const searchQuery = (req.query.search as string) || '';
      const hideVerified = req.query.hideVerified === 'true';
      const excludeAliases = req.query.excludeAliases === 'true'; // not used for now sorry

      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = Math.max(1, Math.min(MAX_LIMIT, limit));
      let where: any = {};
      const directId = searchQuery.match(/^#\d+$/);
      if (directId) {
        const levelId = parseInt(directId[0].slice(1));
        where = {id: levelId};
      }
      else {
      // Build where clause
       where = await buildWhereClause(
        searchQuery, 
        "show", 
        "show",
        false,
        null
      ) || {};
    }

      // First get total count
      let startTime = Date.now();
      let endTime = 0;

      const totalCount = await Level.count({where});

      if (hideVerified) {
        where[Op.and] = {
          ...where,
          isVerified: false
        };
      }
      
      const levelIds = await Level.findAll({
        where,
        attributes: ['id'],
        offset: normalizedOffset,
        limit: normalizedLimit,
      });
      endTime = Date.now();
      logger.debug(`Time taken to get total count: ${endTime - startTime}ms`);


      // Then get paginated results
      startTime = Date.now();
      
      const levels = await Level.findAll({
        where: {id: {[Op.in]: levelIds.map(level => level.id)}},
        attributes: ['id', 'song', 'artist', 'creator', 'isVerified', 'teamId'],
        include: [
          {
            model: Creator,
            as: 'levelCreators',
            include: [
              {
                model: CreatorAlias,
                as: 'creatorAliases',
                attributes: ['id', 'name'],
              }
            ],
          },
          {
            model: Team,
            as: 'teamObject',
            include: [
              {
                model: Creator,
                as: 'members',
                through: {attributes: []},
              },
              {
                model: TeamAlias,
                as: 'teamAliases',
                attributes: ['id', 'name'],
              }
            ],
          },
        ],
        order: [['id', 'ASC']],
      });
      endTime = Date.now();
      logger.debug(`Time taken to get paginated results: ${endTime - startTime}ms`);


      // Get level counts for each creator
      startTime = Date.now();
      const levelCounts = (await LevelCredit.findAll({
        attributes: [
          'creatorId',
          [sequelize.fn('COUNT', sequelize.col('levelId')), 'count'],
        ],
        group: ['creatorId'],
        raw: true,
      })) as unknown as LevelCountResult[];
      endTime = Date.now();
      logger.debug(`Time taken to get level counts: ${endTime - startTime}ms`);

      startTime = Date.now();
      const levelCountMap = new Map(
        levelCounts.map(count => [count.creatorId, parseInt(count.count)]),
      );
      endTime = Date.now();
      logger.debug(`Time taken to get level count map: ${endTime - startTime}ms`);

      startTime = Date.now();
      const audit = levels.map(level => ({
        id: level.id,
        song: level.song,
        artist: level.artist,
        legacyCreator: level.creator,
        isVerified: level.isVerified,
        teamId: level.teamId,
        team: level.teamObject
          ? {
              id: level.teamObject.id,
              name: level.teamObject.name,
              description: level.teamObject.description,
              members: level.teamObject.members,
              aliases: level.teamObject.teamAliases?.map(alias => alias.name) || []
            }
          : null,
        currentCreators: (
          level.levelCreators as (Creator & {LevelCredit: {role: CreditRole}; creatorAliases?: CreatorAlias[]})[]
        )?.map(creator => ({
          id: creator.id,
          name: creator.name,
          role: creator.LevelCredit.role,
          aliases: creator.creatorAliases?.map((alias: CreatorAlias) => alias.name) || [],
          levelCount: levelCountMap.get(creator.id) || 0,
        })),
      }));
      endTime = Date.now();
      logger.debug(`Time taken to get audit: ${endTime - startTime}ms`);

      return res.json({
        count: totalCount,
        results: audit,
      });
    } catch (error) {
      logger.error('Error fetching levels audit:', error);
      return res.status(500).json({error: 'Failed to fetch levels audit'});
    }
  },
);

// Create new creator
router.post('/', async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const { name, aliases = [] } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      await transaction.rollback();
      return res.status(400).json({ error: 'Creator name is required' });
    }

    // Create the creator
    const creator = await Creator.create({
      name: name.trim(),
      isVerified: false
    }, { transaction });

    // Create aliases if provided
    if (aliases && Array.isArray(aliases) && aliases.length > 0) {
      const aliasRecords = aliases.map((alias: string) => ({
        creatorId: creator.id,
        name: alias.trim(),
      }));
      
      await CreatorAlias.bulkCreate(aliasRecords, { transaction });
    }

    // Fetch the creator with its aliases to return
    const creatorWithAliases = await Creator.findByPk(creator.id, {
      include: [
        {
          model: CreatorAlias,
          as: 'creatorAliases',
          attributes: ['id', 'name'],
        }
      ],
      transaction
    });

    await transaction.commit();
    return res.json(creatorWithAliases);
  } catch (error) {
    await transaction.rollback();
    logger.error('Error creating creator:', error);
    return res.status(500).json({ error: 'Failed to create creator' });
  }
});

// Update level creators
router.put('/level/:levelId([0-9]+)', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {levelId} = req.params;
      const {creators} = req.body;

      // Validate level exists
      const level = await Level.findByPk(levelId, {transaction});
      if (!level) {
        await transaction.rollback();
        return res.status(404).json({error: 'Level not found'});
      }

      // Remove existing credits
      await LevelCredit.destroy({
        where: {levelId},
        transaction,
      });

      // Add new credits
      if (creators && creators.length > 0) {
        await LevelCredit.bulkCreate(
          creators.map((c: {id: number; role: CreditRole}) => ({
            levelId,
            creatorId: c.id,
            role: c.role,
          })),
          {transaction},
        );
      }

      await transaction.commit();
      return res.json({message: 'Level creators updated successfully'});
    } catch (error) {
      await transaction.rollback();
      logger.error('Error updating level creators:', error);
      return res.status(500).json({error: 'Failed to update level creators'});
    }
  },
);

// Verify level credits
router.post('/level/:levelId([0-9]+)/verify', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {levelId} = req.params;

      // Find the level first
      const level = await Level.findByPk(levelId, {transaction});
      if (!level) {
        await transaction.rollback();
        return res.status(404).json({error: 'Level not found'});
      }

      // Update all credits for this level to verified
      await LevelCredit.update(
        {isVerified: true},
        {
          where: {levelId},
          transaction,
        },
      );
      await Level.update(
        {isVerified: true},
        {where: {id: levelId}, transaction},
      );

      await transaction.commit();
      return res.json({message: 'Level credits verified successfully'});
    } catch (error) {
      await transaction.rollback();
      logger.error('Error verifying level credits:', error);
      return res.status(500).json({error: 'Failed to verify level credits'});
    }
  },
);

// Unverify level credits
router.post('/level/:levelId([0-9]+)/unverify', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {levelId} = req.params;

      // Find the level first
      const level = await Level.findByPk(levelId, {transaction});
      if (!level) {
        await transaction.rollback();
        return res.status(404).json({error: 'Level not found'});
      }

      // Update all credits for this level to unverified
      await LevelCredit.update(
        {isVerified: false},
        {
          where: {levelId},
          transaction,
        },
      );
      await Level.update(
        {isVerified: false},
        {where: {id: levelId}, transaction},
      );

      await transaction.commit();
      return res.json({message: 'Level credits unverified successfully'});
    } catch (error) {
      await transaction.rollback();
      logger.error('Error unverifying level credits:', error);
      return res.status(500).json({error: 'Failed to unverify level credits'});
    }
  },
);

// Merge creators
router.post('/merge', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {sourceId, targetId} = req.body;
      if (!sourceId || !targetId) {
        await transaction.rollback();
        return res
          .status(400)
          .json({error: 'Source and target IDs are required'});
      }

      // Get source and target creators
      const sourceCreator = await Creator.findByPk(sourceId, {
        include: [
          {
            model: CreatorAlias,
            as: 'creatorAliases',
            attributes: ['id', 'name'],
          }
        ],
        transaction
      });
      const targetCreator = await Creator.findByPk(targetId, {
        include: [
          {
            model: CreatorAlias,
            as: 'creatorAliases',
            attributes: ['id', 'name'],
          }
        ],
        transaction
      });
      if (!sourceCreator || !targetCreator) {
        await transaction.rollback();
        return res.status(404).json({error: 'Creator not found'});
      }

      // Get all level credits for source creator
      const sourceCredits = await LevelCredit.findAll({
        where: {creatorId: sourceId},
        transaction,
      });

      // Transfer credits to target creator
      for (const credit of sourceCredits) {
        await LevelCredit.upsert(
          {
            levelId: credit.levelId,
            creatorId: targetId,
            role: credit.role,
          },
          {transaction},
        );
      }

      // Update LevelSubmissionCreatorRequest records
      await LevelSubmissionCreatorRequest.update(
        { creatorId: targetId },
        { where: { creatorId: sourceId }, transaction }
      );

      // Delete all source credits after transfer
      await LevelCredit.destroy({
        where: {creatorId: sourceId},
        transaction,
      });

      // Merge aliases
      const sourceAliases = sourceCreator.creatorAliases?.map((alias: any) => alias.name) || [];
      const targetAliases = (targetCreator as any).creatorAliases?.map((alias: any) => alias.name) || [];
      const mergedAliases = [
        ...new Set([...targetAliases, ...sourceAliases, sourceCreator.name]),
      ];
      
      // Delete existing target aliases
      await CreatorAlias.destroy({
        where: { creatorId: targetId },
        transaction
      });
      
      // Create new merged aliases
      if (mergedAliases.length > 0) {
        const aliasRecords = mergedAliases.map(alias => ({
          creatorId: targetId,
          name: alias,
        }));
        
        await CreatorAlias.bulkCreate(aliasRecords, { transaction });
      }

      // Delete the source creator
      await sourceCreator.destroy({transaction});

      await transaction.commit();
      return res.json({success: true});
    } catch (error) {
      await transaction.rollback();
      logger.error('Error merging creators:', error);
      return res.status(500).json({error: 'Failed to merge creators'});
    }
  },
);

// Split creator
router.post('/split', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {creatorId, newNames, roles} = req.body;

      // Validate source creator exists
      const source = await Creator.findByPk(creatorId, {
        include: [
          {
            model: Level,
            as: 'createdLevels',
            through: {attributes: ['role']},
          },
          {
            model: CreatorAlias,
            as: 'creatorAliases',
            attributes: ['id', 'name'],
          }
        ],
        transaction,
      });

      if (!source) {
        await transaction.rollback();
        return res.status(404).json({error: 'Creator not found'});
      }

      // Get all level credits for source creator
      const sourceCredits = await LevelCredit.findAll({
        where: {creatorId},
        transaction,
      });

      // Determine default role if creator has exactly one level
      let defaultRole = CreditRole.CHARTER;
      if (sourceCredits.length === 1) {
        defaultRole = sourceCredits[0].role;
      }

      const targetCreators = [];
      // Process each new name
      for (let i = 0; i < newNames.length; i++) {
        const newName = newNames[i];
        const role = roles?.[i] || defaultRole;

        // Check if creator with the new name already exists
        let targetCreator = await Creator.findOne({
          where: {name: newName},
          transaction,
        });

        // If no existing creator found, create a new one
        if (!targetCreator) {
          targetCreator = await Creator.create(
            {
              name: newName,
            },
            {transaction},
          );
        }
        targetCreators.push(targetCreator);

        // Create level credits for each target creator
        for (const credit of sourceCredits) {
          try {
            // Try to create the credit, ignore if it already exists
            await LevelCredit.create(
              {
                levelId: credit.levelId,
                creatorId: targetCreator.id,
                role: role,
                isVerified: false,
              },
              {
                transaction,
                ignoreDuplicates: true, // This tells Sequelize to ignore duplicate entries
              },
            );
          } catch (error: any) {
            // If it's a duplicate entry error, just continue
            if (error.name === 'SequelizeUniqueConstraintError') {
              continue;
            }
            throw error; // Re-throw if it's any other type of error
          }
        }

        // Create LevelSubmissionCreatorRequest records for each new creator
        const creatorRequests = await LevelSubmissionCreatorRequest.findAll({
          where: { creatorId },
          transaction,
        });

        for (const request of creatorRequests) {
          // Update the existing request to point to the new creator instead of creating a new one
          await LevelSubmissionCreatorRequest.update(
            {
              creatorName: newName,
              creatorId: targetCreator.id,
              isNewRequest: true,
            },
            { 
              where: { id: request.id },
              transaction 
            }
          );
        }
      }

      // Delete all source credits after transfer
      await LevelCredit.destroy({
        where: {creatorId},
        transaction,
      });

      // Delete the source creator
      await source.destroy({transaction});

      await transaction.commit();
      return res.json({
        message: 'Creator split successfully',
        newCreators: targetCreators,
      });
    } catch (error) {
      await transaction.rollback();
      logger.error('Error splitting creator:', error);
      return res.status(500).json({error: 'Failed to split creator'});
    }
  },
);

// Update creator
router.put('/:id([0-9]+)', async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();

  try {
    const {id} = req.params;
    const {name, aliases, userId, isVerified} = req.body;

    // Update creator
    await Creator.update(
      {
        name,
        userId,
        isVerified,
      },
      {
        where: {id: parseInt(id)},
        transaction,
      },
    );

    // Update aliases if provided
    if (aliases && Array.isArray(aliases)) {
      // Delete existing aliases
      await CreatorAlias.destroy({
        where: { creatorId: parseInt(id) },
        transaction
      });

      // Create new aliases
      if (aliases.length > 0) {
        const aliasRecords = aliases.map((alias: string) => ({
          creatorId: parseInt(id),
          name: alias.trim(),
        }));
        
        await CreatorAlias.bulkCreate(aliasRecords, { transaction });
      }
    }

    // If the creator is being verified, check all their levels
    if (isVerified) {
      // Get all levels where this creator is credited
      const credits = await LevelCredit.findAll({
        where: {creatorId: parseInt(id)},
        include: [
          {
            model: Level,
            as: 'level',
          },
        ],
        transaction,
      });

      // For each level, check if all creators are now verified
      for (const credit of credits) {
        const level = credit.level;
        if (!level) continue;

        // Get all credits for this level
        const allCredits = await LevelCredit.findAll({
          where: {levelId: level.id},
          include: [
            {
              model: Creator,
              as: 'creator',
            },
          ],
          transaction,
        });

        const allCreatorsVerified = allCredits.every(
          credit => credit.creator?.isVerified,
        );

        if (allCreatorsVerified) {
          await Level.update(
            {isVerified: true},
            {
              where: {id: level.id},
              transaction,
            },
          );
        }
      }
    }

    await transaction.commit();

    // Get updated creator with associations
    const updatedCreator = await Creator.findByPk(id, {
      include: [
        {
          model: Level,
          as: 'createdLevels',
          through: {attributes: ['role']},
        },
        {
          model: User,
          as: 'user',
          attributes: ['id', 'username', 'avatarUrl'],
        },
        {
          model: CreatorAlias,
          as: 'creatorAliases',
          attributes: ['id', 'name'],
        }
      ],
    });

    return res.json(updatedCreator);
  } catch (error) {
    await transaction.rollback();
    logger.error('Error updating creator:', error);
    return res.status(500).json({error: 'Failed to update creator'});
  }
});

// Get all teams with search
router.get('/teams', async (req: Request, res: Response) => {
  try {
    const {search} = req.query;

    const escapedSearch = escapeForMySQL(search as string);

    const teamIds: Set<number> = new Set();

    const teamNameIds = await Team.findAll({
      where: {name: {[Op.like]: `%${escapedSearch}%`}},
      attributes: ['id'],
    });

    for (const team of teamNameIds) {
      teamIds.add(team.id);
    }

    const teamAliasIds = await TeamAlias.findAll({
      where: {name: {[Op.like]: `%${escapedSearch}%`}},
      attributes: ['teamId'],
    });

    for (const alias of teamAliasIds) {
      teamIds.add(alias.teamId);
    }

    const teams = await Team.findAll({
      where: {id: {[Op.in]: Array.from(teamIds)}},
      include: [
        {
          model: Creator,
          as: 'members',
          through: {attributes: []},
        },
        {
          model: TeamAlias,
          as: 'teamAliases',
          attributes: ['id', 'name'],
        }
      ],
      order: [['name', 'ASC']],
    });

    return res.json(teams);
  } catch (error) {
    logger.error('Error fetching teams:', error);
    return res.status(500).json({error: 'Failed to fetch teams'});
  }
});

// Create or update team for level
router.put('/level/:levelId([0-9]+)/team', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {levelId} = req.params;
      const {teamId, name, members} = req.body;

      // Find the level
      const level = await Level.findByPk(levelId, {transaction});
      if (!level) {
        await transaction.rollback();
        return res.status(404).json({error: 'Level not found'});
      }

      // Find or create team
      let team: Team | null = null;
      if (name) {
        if (teamId) {
          // Update existing team
          team = await Team.findByPk(teamId, {transaction});
          if (!team) {
            await transaction.rollback();
            return res.status(404).json({error: 'Team not found'});
          }
        } else {
          // Create new team
          const [upsertedTeam] = await Team.upsert(
            {
              name,
              aliases: [],
            },
            {transaction},
          );
          team = upsertedTeam;
        }

        if (!team) {
          await transaction.rollback();
          return res.status(500).json({error: 'Failed to create/update team'});
        }

        // Update level's team
        await level.update({teamId: team.id}, {transaction});

        // If members are provided, update team members
        if (members) {
          // Get all levels associated with this team
          const teamLevels = await Level.findAll({
            where: {teamId: team.id},
            transaction,
          });

          // Get all creators from these levels
          const levelCreators = await Promise.all(
            teamLevels.map(async level => {
              const credits = await LevelCredit.findAll({
                where: {levelId: level.id},
                transaction,
              });
              return credits.map(credit => credit.creatorId);
            }),
          );

          // Flatten and deduplicate creator IDs
          const allTeamCreators = [...new Set(levelCreators.flat())];

          // Only remove creators that are not present in any level
          const creatorsToRemove = allTeamCreators.filter(
            (creatorId: number) => !members.includes(creatorId),
          );

          // Remove creators that are not in any level
          if (creatorsToRemove.length > 0) {
            await TeamMember.destroy({
              where: {
                teamId: team.id,
                creatorId: {[Op.in]: creatorsToRemove},
              },
              transaction,
            });
          }

          // Add new creators
          const existingMembers = await TeamMember.findAll({
            where: {teamId: team.id},
            transaction,
          });
          const existingCreatorIds = existingMembers.map(
            member => member.creatorId,
          );
          const newCreatorIds = members.filter(
            (creatorId: number) => !existingCreatorIds.includes(creatorId),
          );

          if (newCreatorIds.length > 0) {
            await TeamMember.bulkCreate(
              newCreatorIds.map((creatorId: number) => ({
                teamId: team?.id,
                creatorId,
              })),
              {transaction},
            );
          }
        }
      } else {
        // Remove team association if no team details provided
        await level.update({teamId: null}, {transaction});
      }

      await transaction.commit();

      // Fetch the updated team with members to return
      let updatedTeam = null;
      if (team?.id) {
        updatedTeam = await Team.findByPk(team.id, {
          include: [
            {
              model: Creator,
              as: 'members',
              through: { attributes: [] }
            },
          ]
        });
      }

      if (!updatedTeam) {
        return res.status(500).json({ error: 'Failed to fetch created team' });
      }

      return res.json({
        message: 'Team updated successfully',
        team: updatedTeam,
      });
    } catch (error) {
      await transaction.rollback();
      logger.error('Error updating team:', error);
      return res.status(500).json({error: 'Failed to update team'});
    }
  },
);

// Delete team association from level
router.delete('/level/:levelId([0-9]+)/team', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {levelId} = req.params;

      const level = await Level.findByPk(levelId, {transaction});
      if (!level) {
        await transaction.rollback();
        return res.status(404).json({error: 'Level not found'});
      }

      if (level.teamId) {
        // Check if team is used by other levels
        const otherLevels = await Level.count({
          where: {
            teamId: level.teamId,
            id: {[Op.ne]: levelId},
          },
          transaction,
        });

        if (otherLevels === 0) {
          // Delete team if not used elsewhere
          await TeamMember.destroy({
            where: {teamId: level.teamId},
            transaction,
          });
          await Team.destroy({
            where: {id: level.teamId},
            transaction,
          });
        }
      }

      // Remove team association
      await level.update({teamId: null}, {transaction});

      await transaction.commit();
      return res.json({message: 'Team association removed successfully'});
    } catch (error) {
      await transaction.rollback();
      logger.error('Error removing team:', error);
      return res.status(500).json({error: 'Failed to remove team'});
    }
  },
);

// Delete team
router.delete('/team/:teamId([0-9]+)', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {teamId} = req.params;
      const levelId = req.query.levelId as string;

      // Check if team exists and get associated levels
      const associatedLevels = await Level.findAll({
        where: {teamId},
        transaction,
      });

      const team = await Team.findByPk(teamId, {transaction});
      if (!team) {
        await transaction.rollback();
        return res.status(404).json({error: 'Team not found'});
      }

      // If team has only one level or no levels, delete the team and its associations
      if (associatedLevels.length <= 1) {
        // Remove team members
        await TeamMember.destroy({
          where: {teamId},
          transaction,
        });

        // Remove team from levels
        await Level.update({teamId: null}, {where: {teamId}, transaction});

        // Delete the team
        await team.destroy({transaction});
      } else {
        // If team has multiple levels, just remove the association from this level
        await Level.update(
          {teamId: null},
          {where: {id: parseInt(levelId)}, transaction},
        );
      }

      await transaction.commit();
      return res.json({message: 'Team deleted successfully'});
    } catch (error) {
      await transaction.rollback();
      logger.error('Error deleting team:', error);
      return res.status(500).json({error: 'Failed to delete team'});
    }
  },
);

// Get team details
router.get('/team/:teamId([0-9]+)', async (req: Request, res: Response) => {
  try {
    const {teamId} = req.params;
    const team = await Team.findByPk(teamId, {
      include: [
        {
          model: Creator,
          as: 'members',
          through: {attributes: []},
        },
      ],
    });

    if (!team) {
      return res.status(404).json({error: 'Team not found'});
    }

    return res.json(team);
  } catch (error) {
    logger.error('Error fetching team:', error);
    return res.status(500).json({error: 'Failed to fetch team'});
  }
});

// Link Discord account to creator
router.put('/:creatorId([0-9]+)/discord/:userId', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {creatorId, userId} = req.params;

      // Find the creator
      const creator = await Creator.findByPk(creatorId, {transaction});
      if (!creator) {
        await transaction.rollback();
        return res.status(404).json({error: 'Creator not found'});
      }

      // Find the user
      const user = await User.findByPk(userId, {transaction});
      if (!user) {
        await transaction.rollback();
        return res.status(404).json({error: 'User not found'});
      }

      // Update the creator with the user ID
      await creator.update({userId}, {transaction});

      await transaction.commit();
      return res.json({message: 'Discord account linked successfully'});
    } catch (error) {
      await transaction.rollback();
      logger.error('Error linking Discord account:', error);
      return res.status(500).json({error: 'Failed to link Discord account'});
    }
  },
);

// Unlink Discord account from creator
router.delete('/:creatorId([0-9]+)/discord', Auth.superAdmin(), async (req: Request, res: Response) => {
    const transaction = await sequelize.transaction();
    try {
      const {creatorId} = req.params;

      // Find the creator
      const creator = await Creator.findByPk(creatorId, {transaction});
      if (!creator) {
        await transaction.rollback();
        return res.status(404).json({error: 'Creator not found'});
      }

      // Update the creator to remove the user ID
      await creator.update({userId: null}, {transaction});

      await transaction.commit();
      return res.json({message: 'Discord account unlinked successfully'});
    } catch (error) {
      await transaction.rollback();
      logger.error('Error unlinking Discord account:', error);
      return res.status(500).json({error: 'Failed to unlink Discord account'});
    }
  },
);

// Add search endpoint for creators
router.get('/search/:name', async (req: Request, res: Response) => {
  try {
    // Decode the URI encoded search term
    const name = decodeURIComponent(req.params.name);
    
    // Function to escape special characters for MySQL
    const escapedName = escapeForMySQL(name);
    
    const creatorsByName = await Creator.findAll({
      where: {name: {[Op.like]: `%${escapedName}%`}},
      attributes: ['id'],
    });

    const creatorsByAlias = await CreatorAlias.findAll({
      where: {name: {[Op.like]: `%${escapedName}%`}},
      attributes: ['creatorId'],
    });

    const creatorIds: Set<number> = 
    new Set(creatorsByName.map(creator => creator.id)
    .concat(creatorsByAlias.map(alias => alias.creatorId)));

    const creators = await Creator.findAll({
      where: {id: {[Op.in]: Array.from(creatorIds)}},
      include: [
        {
          model: CreatorAlias,
          as: 'creatorAliases',
          attributes: ['id', 'name'],
          required: false,
        }
      ],
      limit: 30,
      attributes: ['id', 'name', 'isVerified']
    });

    return res.json(creators);
  } catch (error) {
    logger.error('Error searching creators:', error);
    return res.status(500).json({
      error: 'Failed to search creators',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Create new team
router.post('/teams', Auth.superAdmin(), async (req: Request, res: Response) => {
  const transaction = await sequelize.transaction();
  try {
    const { name, aliases, description } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      await transaction.rollback();
      return res.status(400).json({ error: 'Team name is required' });
    }

    // Check for existing team with the same name (case insensitive)
    const existingTeam = await Team.findOne({
      where: {
        [Op.or]: [
          sequelize.where(
            sequelize.fn('LOWER', sequelize.col('name')),
            sequelize.fn('LOWER', name.trim())
          ),
          // For MySQL search with escaped characters
          sequelize.literal(`EXISTS (
            SELECT 1 FROM team_aliases 
            WHERE team_aliases.name = '${name.trim()}'
          )`)
        ]
      },
      transaction
    });

    if (existingTeam) {
      await transaction.rollback();
      return res.status(400).json({
        error: `A team with the name "${name}" already exists (ID: ${existingTeam.id})`
      });
    }

    // Check if any of the aliases match existing team names
    if (aliases && Array.isArray(aliases)) {
      const aliasConditions = aliases.map(alias => ({
        [Op.or]: [
          sequelize.where(
            sequelize.fn('LOWER', sequelize.col('name')),
            sequelize.fn('LOWER', alias.trim())
          ),
          // For MySQL search with escaped characters
          sequelize.literal(`EXISTS (
            SELECT 1 FROM team_aliases 
            WHERE team_aliases.name = '${alias.trim()}'
          )`)
        ]
      }));

      const existingAliases = await Team.findOne({
        where: {
          [Op.or]: aliasConditions
        },
        transaction
      });

      if (existingAliases) {
        await transaction.rollback();
        return res.status(400).json({
          error: `One of the aliases conflicts with an existing team (ID: ${existingAliases.id})`
        });
      }
    }

    // Create the team with all fields from the model
    const team = await Team.create(
      {
        name: name.trim(),
        description: description?.trim() || null,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      { transaction }
    );

    // Create aliases if provided
    if (aliases && Array.isArray(aliases) && aliases.length > 0) {
      const aliasRecords = aliases.map((alias: string) => ({
        teamId: team.id,
        name: alias.trim(),
      }));
      
      await TeamAlias.bulkCreate(aliasRecords, { transaction });
    }

    await transaction.commit();

    // Return the team with its members
    const teamWithMembers = await Team.findByPk(team.id, {
      include: [
        {
          model: Creator,
          as: 'members',
          through: { attributes: [] }
        },
        {
          model: TeamAlias,
          as: 'teamAliases',
          attributes: ['id', 'name'],
        }
      ]
    });

    if (!teamWithMembers) {
      return res.status(500).json({ error: 'Failed to fetch created team' });
    }

    return res.json({
      id: teamWithMembers.id,
      name: teamWithMembers.name,
      description: teamWithMembers.description,
      type: 'team',
      members: teamWithMembers.members?.map(member => ({
        id: member.id,
        name: member.name
      })),
      aliases: teamWithMembers.teamAliases?.map(alias => alias.name) || []
    });
  } catch (error) {
    await transaction.rollback();
    logger.error('Error creating team:', error);
    return res.status(500).json({ error: 'Failed to create team' });
  }
});

// Add search endpoint for teams
router.get('/teams/search/:name', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;

    const escapedName = escapeForMySQL(name);

    const teamIds: Set<number> = new Set();

    const teamNameIds = await Team.findAll({
      where: {name: {[Op.like]: `%${escapedName}%`}},
      attributes: ['id'],
    });

    const teamAliasIds = await TeamAlias.findAll({
      where: {name: {[Op.like]: `%${escapedName}%`}},
      attributes: ['teamId'],
    });

    for (const team of teamNameIds) {
      teamIds.add(team.id);
    }

    for (const alias of teamAliasIds) {
      teamIds.add(alias.teamId);
    }

    const teams = await Team.findAll({
      where: {
        [Op.or]: [
          {id: {[Op.in]: Array.from(teamIds)}},
        ]
      },
      include: [
        {
          model: Creator,
          as: 'members',
          through: { attributes: [] }
        },
        {
          model: TeamAlias,
          as: 'teamAliases',
          attributes: ['id', 'name'],
        }
      ],
      limit: 10
    });

    // Format response to match ProfileSelector expectations
    return res.json(teams.map(team => ({
      id: team.id,
      name: team.name,
      type: 'team',
      members: team.members?.map(member => ({
        id: member.id,
        name: member.name
      })),
      aliases: team.teamAliases?.map(alias => alias.name) || []
    })));

  } catch (error) {
    logger.error('Error searching teams:', error);
    return res.status(500).json({ error: 'Failed to search teams' });
  }
});

export default router;
