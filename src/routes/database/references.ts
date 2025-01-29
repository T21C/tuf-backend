import {Request, Response, Router} from 'express';
import {Op} from 'sequelize';
import Reference from '../../models/References.js';
import Difficulty from '../../models/Difficulty.js';
import Level from '../../models/Level.js';
import {Auth} from '../../middleware/auth.js';

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
          through: {attributes: []},
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
      levels: diff.referenceLevels,
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
          through: {attributes: []},
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
      levels: difficulty.referenceLevels,
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
    const {difficultyId, levelId} = req.body;

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
    const {difficultyId, levelId} = req.body;

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

export default router;
