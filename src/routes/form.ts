import express, {Request, Response, Router} from 'express';
import { verifyAccessToken } from '../utils/authHelpers.js';
import { emailBanList } from '../config/constants.js';
import ChartSubmission from '../models/ChartSubmission';
import { PassSubmission, PassSubmissionJudgements, PassSubmissionFlags } from '../models/PassSubmission';
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
            const submission = await ChartSubmission.create({
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
            });

            return res.json({ 
                success: true, 
                message: 'Chart submission saved successfully',
                submissionId: submission.id 
            });
        } 
        
        if (formType === 'pass') {
            const submission = await PassSubmission.create({
                rawVideoId: req.body['rawVideoId'],
                levelId: req.body['levelId'],
                passer: req.body['passer'],
                speed: parseFloat(req.body['speed'] || '1'),
                feelingDifficulty: req.body['feelingDifficulty'],
                title: req.body['title'],
                rawTime: new Date(req.body['rawTime']),
                submitterDiscordUsername: tokenInfo.username,
                submitterEmail: tokenInfo.email,
                status: 'pending'
            });

            // Create associated judgements
            await PassSubmissionJudgements.create({
                passSubmissionId: submission.id,
                earlyDouble: parseInt(req.body['earlyDouble'] || '0'),
                earlySingle: parseInt(req.body['earlySingle'] || '0'),
                ePerfect: parseInt(req.body['ePerfect'] || '0'),
                perfect: parseInt(req.body['perfect'] || '0'),
                lPerfect: parseInt(req.body['lPerfect'] || '0'),
                lateSingle: parseInt(req.body['lateSingle'] || '0'),
                lateDouble: parseInt(req.body['lateDouble'] || '0')
            });

            // Create associated flags
            await PassSubmissionFlags.create({
                passSubmissionId: submission.id,
                is12k: req.body['is12k'] === 'true',
                isNHT: req.body['isNHT'] === 'true',
                is16k: req.body['is16k'] === 'true',
                isLegacy: false
            });

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
  
  