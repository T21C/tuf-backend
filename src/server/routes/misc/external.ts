import { Router } from 'express';
import Level from '@/models/levels/Level.js';
import { Auth } from '@/server/middleware/auth.js';
import { logger } from '@/server/services/LoggerService.js';
import cdnService from '@/server/services/CdnService.js';
import axios from 'axios';


const AUTORATER_UUID = process.env.AUTORATER_UUID;
if (!AUTORATER_UUID) {
    throw new Error('AUTORATER_UUID is not set');
}
const router = Router();

router.get('/autorate/:levelId', async (req, res) => {
    try {
    const levelId = req.params.levelId;
    
    if (!levelId) {
        return res.status(400).json({ error: 'Level ID is required' });
    }

    const level = await Level.findByPk(levelId);
    if (!level || level.isDeleted || level.isHidden) {
        return res.status(404).json({ error: 'Level not found' });
    }

    const levelFile = await cdnService.getLevelAdofai(level) || await fetch("https://api.tuforums.com/v2/database/levels/" + levelId + "/level.adofai").then(res => res.json());

    if (!levelFile) {
        return res.status(404).json({ error: 'No level file available' });
    }

    const requestBody = {
        "Content": levelFile,
        "techMode": false
    }

    const response = await axios.post(`${process.env.OWOSEAN_API_URL}/rate`, requestBody);

    if (response.status !== 200) {
        return res.status(500).json({ error: 'Failed to autorate level', response: response.data });
    }

    return res.json({
        response: response.data,
        message: 'Level autorated successfully',
    });
} catch (error: any) {
    if (error.response) {
        return res.status(500).json({ error: 'Failed to autorate level', response: error.response.data });
    }
    logger.error('Error autorating level:', error);
    return res.status(500).json({ error: 'Failed to autorate level' });
}
});

export default router;