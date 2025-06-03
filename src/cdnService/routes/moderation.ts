import { logger } from "../../services/LoggerService.js";
import { getPendingImages, moderateImage } from "../services/moderation.js";
import { Request, Response, Router } from 'express';

const router = Router();

// Moderation endpoints
router.get('/pending', async (req: Request, res: Response) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 20;
        
        const result = await getPendingImages(page, limit);
        res.json(result);
    } catch (error) {
        logger.error('Failed to fetch pending images:', error);
        res.status(500).json({ 
            error: 'Failed to fetch pending images',
            details: error instanceof Error ? error.message : String(error)
        });
    }
});

router.post('/:fileId', async (req: Request, res: Response) => {
    try {
        const { fileId } = req.params;
        const { approved, reason } = req.body;
        const moderatorId = req.user?.id; // Assuming you have user authentication middleware

        if (!moderatorId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        await moderateImage(fileId, approved, moderatorId, reason);
        
        res.json({
            success: true,
            message: approved ? 'Image approved' : 'Image rejected'
        });
    } catch (error) {
        logger.error('Moderation error:', error);
        res.status(500).json({ 
            error: 'Moderation failed',
            details: error instanceof Error ? error.message : String(error)
        });
    }
    return;
});

export default router;
