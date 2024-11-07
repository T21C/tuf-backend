import express from 'express';
import {verifyAccessToken} from '../utils/authHelpers.js';
import {emailBanList} from '../config/constants.js';
import PassSubmission from '../models/PassSubmission.js';
import ChartSubmission from '../models/ChartSubmission.js';
import axios from 'axios';

const router = express.Router();

// Form submission endpoint
router.post('/form-submit', async (req, res) => {
  const accessToken = req.headers.authorization?.split(' ')[1]; // Extract access token from headers

  if (!accessToken) {
    return res.status(401).json({error: 'Missing access token'});
  }

  //console.log("form type extracted", formType);

  // Verify the access token first
  const tokenInfo = await verifyAccessToken(accessToken!);

  if (!tokenInfo) {
    return res.status(401).json({error: 'Invalid access token'});
  }

  // Check if the user is in the ban list
  if (emailBanList.includes(tokenInfo.email)) {
    return res.status(403).json({error: 'User is banned'});
  }

  // Prepare to forward the form submission to Google Apps Script
  const appScriptUrl = process.env.FORM_SCRIPT_URL; // Read the script URL from .env

  console.log('request received: ', req);

  // Extract form type from headers
  const formType = req.headers['x-form-type'];

  // Parse the form data based on form type
  let formData;
  if (formType === 'pass') {
    formData = {
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
        lateDouble: parseInt(req.body['Late!!'] || 0),
      },
      flags: {
        is12k: req.body['12K'],
        isNHT: req.body['NHT'],
        test16k: req.body['test16k'],
      },
      submitter: {
        discordUsername: tokenInfo.username,
        email: tokenInfo.email,
      },
    };
  } else if (formType === 'chart') {
    formData = {
      artist: req.body['artist'],
      charter: req.body['charter'],
      diff: req.body['diff'],
      song: req.body['song'],
      team: req.body['team'],
      vfxer: req.body['vfxer'],
      videoLink: req.body['videoLink'],
      directDL: req.body['directDL'],
      wsLink: req.body['wsLink'],
      submitter: {
        discordUsername: tokenInfo.username,
        email: tokenInfo.email,
      },
    };
  }

  // Save to appropriate collection based on form type
  let submission;
  if (formType === 'pass') {
    submission = new PassSubmission(formData);
  } else if (formType === 'chart') {
    submission = new ChartSubmission(formData);
  } else {
    return res.status(400).json({error: 'Invalid form type'});
  }

  try {
    await submission.save();
  } catch (error) {
    console.error('Database save error:', error);
    return res
      .status(500)
      .json({error: 'Failed to save submission to database'});
  }

  // Continue with existing Google Apps Script submission
  const reqFull = {
    ...req.body,
    _submitterEmail: tokenInfo.email,
    _discordUsername: tokenInfo.username,
  };
  const reqString = new URLSearchParams(reqFull).toString();
  const filtered = reqString.replace(/%0A/g, '');
  try {
    const formResponse = await axios.post(appScriptUrl!, {
      headers: {
        Authorization: `Bearer ${accessToken}`, // Forward the access token to Google Apps Script
        'Content-Type': 'application/x-www-form-urlencoded', // Custom header indicating form type
      },
      body: filtered, // Send the form data
    });

    if (formResponse.status !== 200) {
      const errorData = await formResponse.data;
      return res.status(500).json({
        error: 'Failed to submit form to Google Apps Script',
        details: errorData,
      });
    }

    return res.json({success: true, message: 'Form submitted successfully'});
  } catch (error) {
    console.error('Error forwarding form submission:', error);
    res.status(500).json({error: 'Internal Server Error'});
  }
});

export default router;
