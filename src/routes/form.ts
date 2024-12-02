import express, {Request, Response, Router} from 'express';
import { verifyAccessToken } from '../utils/authHelpers.js';
import { emailBanList } from '../config/constants.js';
import PassSubmission from '../models/PassSubmission.js';
import ChartSubmission from '../models/ChartSubmission.js';
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
      
        console.log(req.headers);
        
        const formType = req.headers['x-form-type'];
        
        if (formType === 'chart') {
            const formData = {
                artist: req.body['artist'],
                charter: req.body['charter'],
                diff: req.body['diff'],
                song: req.body['song'],
                team: req.body['team'] || '',  // Using default value if empty
                vfxer: req.body['vfxer'] || '',
                videoLink: req.body['videoLink'],
                directDL: req.body['directDL'],
                wsLink: req.body['wsLink'] || '',
                submitter: {
                    discordUsername: tokenInfo.username,
                    userId: tokenInfo.id
                },
                status: 'pending',
                toRate: false
            };

            const submission = new ChartSubmission(formData);
            await submission.save();

            return res.json({ 
                success: true, 
                message: 'Chart submission saved successfully',
                submissionId: submission._id 
            });
        } 
        
        console.log(req.body);
        // Handle pass submissions separately
        if (formType === 'pass') {
            const formData = {
                levelId: req.body['levelId'],
                speedTrial: !!req.body['speedTrial'],
                passer: req.body['passer'],
                feelingDifficulty: req.body['feelingDifficulty'],
                title: req.body['title'],
                rawVideoId: req.body['rawVideoId'],
                rawTime: new Date(req.body['rawTime']),
                judgements: {
                    earlyDouble: parseInt(req.body['earlyDouble'] || 0),
                    earlySingle: parseInt(req.body['earlySingle'] || 0),
                    ePerfect: parseInt(req.body['ePerfect'] || 0),
                    perfect: parseInt(req.body['perfect'] || 0),
                    lPerfect: parseInt(req.body['lPerfect'] || 0),
                    lateSingle: parseInt(req.body['lateSingle'] || 0),
                    lateDouble: parseInt(req.body['lateDouble'] || 0)
                },
                flags: {
                    is12k: req.body['is12k'],
                    isNHT: req.body['isNHT'],
                    is16k: req.body['is16k']
                },
                submitter: {
                    discordUsername: tokenInfo.username,
                    email: tokenInfo.email
                }
            };

            const submission = new PassSubmission(formData);
            await submission.save();

            return res.json({ 
                success: true, 
                message: 'Pass submission saved successfully',
                submissionId: submission._id 
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
  
  