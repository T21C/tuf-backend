import { Router, Request, Response } from "express";
import { Auth } from "../../../middleware/auth.js";
import { filterLevels } from "./index.js";
import Difficulty from "../../../models/levels/Difficulty.js";
import Level from "../../../models/levels/Level.js";
import Pass from "../../../models/passes/Pass.js";
import LevelCredit from "../../../models/levels/LevelCredit.js";
import Team from "../../../models/credits/Team.js";
import Creator from "../../../models/credits/Creator.js";
import LevelAlias from "../../../models/levels/LevelAlias.js";
import sequelize from "../../../config/db.js";
import { Op, Transaction } from "sequelize";
import Player from "../../../models/players/Player.js";
import Judgement from "../../../models/passes/Judgement.js";
import { CreatorAlias } from "../../../models/credits/CreatorAlias.js";
import RatingDetail from "../../../models/levels/RatingDetail.js";
import Rating from "../../../models/levels/Rating.js";
import LevelLikes from "../../../models/levels/LevelLikes.js";
import { User } from "../../../models/index.js";
import RatingAccuracyVote from "../../../models/levels/RatingAccuracyVote.js";

const router: Router = Router()

router.get('/', Auth.addUserToRequest(), async (req: Request, res: Response) => {
    try {
      const {query, sort, offset, limit, deletedFilter, clearedFilter, pguRange, specialDifficulties, onlyMyLikes} =
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
        clearedFilter as string,
        onlyMyLikes === 'true',
        req.user?.id || null);
  
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
  router.post('/filter', Auth.addUserToRequest(), async (req: Request, res: Response) => {
    try {
      const {pguRange, specialDifficulties} = req.body;
      const {query, sort, offset, limit, deletedFilter, clearedFilter, onlyMyLikes} =
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
        clearedFilter as string,
        onlyMyLikes === 'true',
        req.user?.id || null);
  
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
        return res.status(404).end();
      }
  
      return res.status(200).end();
    } catch (error) {
      console.error('Error checking level permissions:', error);
      return res.status(500).end();
    }
  });
  
  router.get('/:id', Auth.addUserToRequest(), async (req: Request, res: Response) => {
    try {
      const includeRatings = req.query.includeRatings === 'true';
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
                  include: [
                    {
                      model: CreatorAlias,
                      as: 'creatorAliases',
                      attributes: ['name'],
                    },
                  ],
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
        
        const votes = await RatingAccuracyVote.findAll({
          where: { 
            levelId: parseInt(req.params.id), 
            diffId: level?.difficulty?.id
          },
          include: [
            {
              model: User,
              as: 'user',
              attributes: ['username', 'avatarUrl'],
              include: [
                {
                  model: Player,
                  as: 'player',
                  attributes: ['name'],
                },
              ],
            },
          ],
        });

        const totalVotes = votes.length;

        const isLiked = req.user ? !!(await LevelLikes.findOne({
          where: { levelId: parseInt(req.params.id), userId: req.user?.id },
        })) : false;
  
        const isCleared = req.user?.playerId ? !!(await Pass.findOne({
          where: { levelId: parseInt(req.params.id), playerId: req.user?.playerId },
        })) : false;
  
        await transaction.commit();
  
  
        if (!level) {
          return res.status(404).json({ error: 'Level not found' });
        }
  
        // If level is deleted and user is not super admin, return 404
        if (level.isDeleted && !req.user?.isSuperAdmin) {
          return res.status(404).json({ error: 'Level not found' });
        }
        
  
        return res.json({
          level,
          ratings: includeRatings ? ratings : undefined,
          votes: req.user?.isSuperAdmin ? votes : undefined,
          totalVotes,
          isLiked,
          isCleared,
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
  
  export default router;