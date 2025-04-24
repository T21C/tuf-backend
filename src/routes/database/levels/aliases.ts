import { Router, Request, Response } from 'express';
import sequelize from '../../../config/db.js';
import LevelAlias from '../../../models/levels/LevelAlias.js';
import Level from '../../../models/levels/Level.js';
import { Auth } from '../../../middleware/auth.js';
import { sanitizeTextInput } from './index.js';
import { Op } from 'sequelize';
const router = Router();

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
  
  export default router;
