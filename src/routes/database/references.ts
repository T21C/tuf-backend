import {Request, Response, Router} from 'express';
import {Op, Transaction} from 'sequelize';
import Reference from '../../models/References.js';
import Difficulty from '../../models/Difficulty.js';
import Level from '../../models/Level.js';
import {Auth} from '../../middleware/auth.js';
import sequelize from '../../config/db.js';

interface ILevelWithReference extends Level {
  reference?: {
    type: string | null;
  };
}

interface IReferenceUpdate {
  levelId: number;
  type: string;
}

const router: Router = Router();

// Get all references grouped by difficulty
router.get('/', async (req: Request, res: Response) => {
  try {
    // First get all difficulties with their references
    const difficulties = await Difficulty.findAll({
      where: {
        type: 'PGU', // Only get PGU difficulties
      },
      include: [
        {
          model: Level,
          as: 'referenceLevels',
          through: {
            attributes: ['type'], // Include the type from the Reference model
            as: 'reference' // This will be the name of the property containing the reference data
          },
          where: {
            isDeleted: false, // Only include non-deleted levels
          },
          required: false, // LEFT JOIN to include difficulties without levels
        },
      ],
      order: [
        ['sortOrder', 'ASC'], // Order difficulties by their sort order
        [{model: Level, as: 'referenceLevels'}, 'id', 'ASC'], // Order levels by ID
      ],
    });

    // Transform the data into a more usable format
    const formattedReferences = difficulties.map(diff => ({
      difficulty: diff,
      levels: (diff.referenceLevels as ILevelWithReference[]).map(level => ({
        ...level.toJSON(),
        type: level.reference?.type || '' // Get the type from the reference, default to empty string
      })),
    }));

    return res.json(formattedReferences);
  } catch (error) {
    console.error('Error fetching references:', error);
    return res.status(500).json({error: 'Failed to fetch references'});
  }
});

// Get references for a specific difficulty
router.get('/difficulty/:difficultyId', async (req: Request, res: Response) => {
  try {
    const {difficultyId} = req.params;

    const difficulty = await Difficulty.findOne({
      where: {id: difficultyId},
      include: [
        {
          model: Level,
          as: 'referenceLevels',
          through: {
            attributes: ['type'],
            as: 'reference'
          },
          where: {
            isDeleted: false,
          },
          required: false,
        },
      ],
    });

    if (!difficulty) {
      return res.status(404).json({error: 'Difficulty not found'});
    }

    const formattedReference = {
      difficulty,
      levels: (difficulty.referenceLevels as ILevelWithReference[]).map(level => ({
        ...level.toJSON(),
        type: level.reference?.type || ''
      })),
    };

    return res.json(formattedReference);
  } catch (error) {
    console.error('Error fetching references by difficulty:', error);
    return res.status(500).json({error: 'Failed to fetch references'});
  }
});

// Get references by level ID
router.get('/level/:levelId', async (req: Request, res: Response) => {
  try {
    const {levelId} = req.params;
    const references = await Reference.findAll({
      where: {levelId},
      include: [
        {
          model: Difficulty,
          as: 'difficultyReference',
        },
      ],
    });
    return res.json(references);
  } catch (error) {
    console.error('Error fetching references by level:', error);
    return res.status(500).json({error: 'Failed to fetch references'});
  }
});

// Create a new reference
router.post('/', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const {difficultyId, levelId, type} = req.body;

    // Check if reference already exists
    const existingReference = await Reference.findOne({
      where: {
        difficultyId,
        levelId,
      },
    });

    if (existingReference) {
      return res.status(409).json({error: 'Reference already exists'});
    }

    // Create new reference
    const reference = await Reference.create({
      difficultyId,
      levelId,
      type,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return res.status(201).json(reference);
  } catch (error) {
    console.error('Error creating reference:', error);
    return res.status(500).json({error: 'Failed to create reference'});
  }
});

// Update a reference
router.put('/:id', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const {id} = req.params;
    const {difficultyId, levelId, type} = req.body;

    const reference = await Reference.findByPk(id);
    if (!reference) {
      return res.status(404).json({error: 'Reference not found'});
    }

    // Check if the new combination already exists
    const existingReference = await Reference.findOne({
      where: {
        difficultyId,
        levelId,
        id: {[Op.ne]: id}, // Exclude current reference
      },
    });

    if (existingReference) {
      return res
        .status(409)
        .json({error: 'Reference with these IDs already exists'});
    }

    await reference.update({
      difficultyId,
      levelId,
      type,
      updatedAt: new Date(),
    });

    return res.json(reference);
  } catch (error) {
    console.error('Error updating reference:', error);
    return res.status(500).json({error: 'Failed to update reference'});
  }
});

// Delete a reference
router.delete(
  '/:id',
  Auth.superAdmin(),
  async (req: Request, res: Response) => {
    try {
      const {id} = req.params;
      const reference = await Reference.findByPk(id);

      if (!reference) {
        return res.status(404).json({error: 'Reference not found'});
      }

      await reference.destroy();
      return res.json({message: 'Reference deleted successfully'});
    } catch (error) {
      console.error('Error deleting reference:', error);
      return res.status(500).json({error: 'Failed to delete reference'});
    }
  },
);

// Bulk update references for a difficulty
router.put('/bulk/:difficultyId', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { difficultyId } = req.params;
    const { references } = req.body as { references: IReferenceUpdate[] };

    // Start a transaction to ensure all operations succeed or none do
    const result = await sequelize.transaction(async (t: Transaction) => {
      // Get current references for this difficulty
      const currentRefs = await Reference.findAll({
        where: { difficultyId: parseInt(difficultyId) },
        transaction: t
      });

      // Create maps for easier lookup
      const currentRefMap = new Map(currentRefs.map(ref => [ref.levelId, ref]));
      const newRefMap = new Map(references.map(ref => [ref.levelId, ref]));

      // Find references to add and remove
      const toAdd = references.filter(ref => !currentRefMap.has(ref.levelId));
      const toRemove = currentRefs.filter(ref => !newRefMap.has(ref.levelId));
      const toUpdate = references.filter(ref => 
        currentRefMap.has(ref.levelId) && 
        currentRefMap.get(ref.levelId)?.type !== ref.type
      );

      // Remove references that are no longer needed
      await Promise.all(toRemove.map(ref => ref.destroy({ transaction: t })));

      // Add new references
      await Promise.all(toAdd.map(ref => 
        Reference.create({
          difficultyId: parseInt(difficultyId),
          levelId: ref.levelId,
          type: ref.type,
          createdAt: new Date(),
          updatedAt: new Date()
        }, { transaction: t })
      ));

      // Update existing references
      await Promise.all(toUpdate.map(ref => 
        currentRefMap.get(ref.levelId)?.update({
          type: ref.type,
          updatedAt: new Date()
        }, { transaction: t })
      ));

      return {
        added: toAdd.length,
        removed: toRemove.length,
        updated: toUpdate.length
      };
    });

    return res.json(result);
  } catch (error) {
    console.error('Error bulk updating references:', error);
    return res.status(500).json({ error: 'Failed to bulk update references' });
  }
});

export default router;
