import express, {Request, Response, Router} from 'express';
import { verifyAccessToken } from '../utils/authHelpers.js';
import { emailBanList } from '../config/constants.js';
import ChartSubmission from '../models/ChartSubmission';
import { PassSubmission } from '../models/PassSubmission';
const router: Router = express.Router();

// Form submission endpoint
router.post('/form-submit', async (req: Request, res: Response) => {
    try {
        if (!req.headers.authorization) {
            return res.status(401).json({ error: 'No authorization header' });
        }
        const accessToken = req.headers.authorization.split(' ')[1];
        const tokenInfo = await verifyAccessToken(accessToken);
      
        if (!tokenInfo) {
            return res.status(401).json({ error: 'Invalid access token' });
        }
      
        if (emailBanList.includes(tokenInfo.email)) {
            return res.status(403).json({ error: 'User is banned' });
        }
        
        const formType = req.headers['x-form-type'];
        
        if (formType === 'chart') {
            const [submission, created] = await ChartSubmission.findOrCreate({
                where: {
                    videoLink: req.body['videoLink']  // Assuming videoLink is unique
                },
                defaults: {
                    artist: req.body['artist'],
                    charter: req.body['charter'],
                    diff: req.body['diff'],
                    song: req.body['song'],
                    team: req.body['team'] || '',
                    vfxer: req.body['vfxer'] || '',
                    videoLink: req.body['videoLink'],
                    directDL: req.body['directDL'],
                    wsLink: req.body['wsLink'] || '',
                    submitter_discord: tokenInfo.username,
                    submitter_id: tokenInfo.id,
                    status: 'pending',
                    toRate: false
                }
            });

            if (!created) {
                return res.status(409).json({
                    success: false,
                    message: 'Chart submission already exists',
                    submissionId: submission.id
                });
            }

            return res.json({ 
                success: true, 
                message: 'Chart submission saved successfully',
                submissionId: submission.id 
            });
        } 
        
        if (formType === 'pass') {
            const [submission, created] = await PassSubmission.findOrCreate({
                where: {
                    rawVideoId: req.body['rawVideoId']  // Assuming rawVideoId is unique
                },
                defaults: {
                    levelId: req.body['levelId'],
                    speedTrial: !!req.body['speedTrial'],
                    passer: req.body['passer'],
                    feelingDifficulty: req.body['feelingDifficulty'],
                    title: req.body['title'],
                    rawVideoId: req.body['rawVideoId'],
                    rawTime: new Date(req.body['rawTime']),
                    early_double: parseInt(req.body['earlyDouble'] || '0'),
                    early_single: parseInt(req.body['earlySingle'] || '0'),
                    e_perfect: parseInt(req.body['ePerfect'] || '0'),
                    perfect: parseInt(req.body['perfect'] || '0'),
                    l_perfect: parseInt(req.body['lPerfect'] || '0'),
                    late_single: parseInt(req.body['lateSingle'] || '0'),
                    late_double: parseInt(req.body['lateDouble'] || '0'),
                    is_12k: req.body['is12k'],
                    is_nht: req.body['isNHT'],
                    is_16k: req.body['is16k'],
                    submitter_discord: tokenInfo.username,
                    submitter_email: tokenInfo.email
                }
            });

            if (!created) {
                return res.status(409).json({
                    success: false,
                    message: 'Pass submission already exists',
                    submissionId: submission.id
                });
            }

            return res.json({ 
                success: true, 
                message: 'Pass submission saved successfully',
                submissionId: submission.id 
            });
        }

        return res.status(400).json({ error: 'Invalid form type' });

    } catch (error) {
        console.error('Submission error:', error);
        return res.status(500).json({ 
            error: 'Failed to process submission',
            details: error instanceof Error ? error.message : String(error)
        });
    }
});

export default router;
  
  