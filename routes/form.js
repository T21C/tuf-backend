import express from 'express';
import { verifyAccessToken } from '../utils/authHelpers.js';
import { emailBanList } from '../config/constants.js';
import PassSubmission from '../models/PassSubmission.js';
import ChartSubmission from '../models/ChartSubmission.js';

const router = express.Router();

// Form submission endpoint
router.post('/form-submit', async (req, res) => {
    try {
        const accessToken = req.headers.authorization.split(' ')[1];
        const tokenInfo = await verifyAccessToken(accessToken);
      
        if (!tokenInfo) {
            return res.status(401).json({ error: 'Invalid access token' });
        }
      
        if (emailBanList.includes(tokenInfo.email)) {
            return res.status(403).json({ error: 'User is banned' });
        }
      
        const formType = req.headers['x-form-type'];
        console.log(tokenInfo);
        
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
        
        // Handle pass submissions separately
        if (formType === 'pass') {
            const formData = {
                speedTrial: !!req.body['*/Speed Trial'],
                passer: req.body['Passer'],
                feelingDifficulty: req.body['Feeling Difficulty'],
                title: req.body['Title'],
                rawVideoId: req.body['*/Raw Video ID'],
                rawTime: new Date(req.body['*/Raw Time (GMT)']),
                judgements: {
                    earlyDouble: parseInt(req.body['Early!!'] || 0),
                    earlySingle: parseInt(req.body['Early!'] || 0),
                    ePerfect: parseInt(req.body['EPerfect!'] || 0),
                    perfect: parseInt(req.body['Perfect!'] || 0),
                    lPerfect: parseInt(req.body['LPerfect!'] || 0),
                    lateSingle: parseInt(req.body['Late!'] || 0),
                    lateDouble: parseInt(req.body['Late!!'] || 0)
                },
                flags: {
                    is12k: req.body['12K'],
                    isNHT: req.body['NHT'],
                    test16k: req.body['test16k']
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
            details: error.message 
        });
    }
});

export default router;
  
  