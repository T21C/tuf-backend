import express, {Request, Response, Router} from 'express';
import {verifyAccessToken} from '../utils/authHelpers.js';
import axios from 'axios';
import {type RESTPostOAuth2AccessTokenResult} from 'discord-api-types/v10';
import { SUPER_ADMINS } from '../config/constants';
import { RaterService } from '../services/RaterService';

const router: Router = express.Router();

// CURRENTLY NOT IN USE
router.post('/google-auth', async (req: Request, res: Response) => {
  const {code} = req.body; // Extract code object from request body

  if (!code || !code.access_token) {
    return res.status(400).json({error: 'No access token provided'});
  }

  const access_token = code.access_token; // Get the access token

  try {
    const tokenInfo = await verifyAccessToken(access_token); // Validate token

    if (!tokenInfo) {
      return res.status(401).json({error: 'Invalid access token'});
    }

    // Fetch the user info if token is valid
    const userInfoResponse = await axios.get(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      },
    );

    if (userInfoResponse.status !== 200) {
      return res.status(401).json({error: 'Failed to fetch user info'});
    }

    const userInfo = userInfoResponse.data;
    //console.log("userInfo", userInfo);

    // Token is valid, return the token info and user profile
    return res.json({
      valid: true,
      tokenInfo,
      profile: userInfo,
    });
  } catch (error) {
    console.error('Error verifying token:', error);
    return res.status(500).json({error: 'Internal Server Error'});
  }
});

router.post('/discord-auth', async (req: Request, res: Response) => {
  const {code} = req.body; // Get the authorization code from request body

  if (!code) {
    return res.status(400).json({error: 'Authorization code is required'});
  }

  try {
    const requestBody = new URLSearchParams({
      client_id: process.env.CLIENT_ID!,
      client_secret: process.env.CLIENT_SECRET!,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${process.env.CLIENT_URL}/callback`, // Adjust this as needed
    }).toString();

    //console.log('Request Body:', requestBody); // Log request body

    const tokenResponseData = await axios.post(
      'https://discord.com/api/oauth2/token',
      requestBody,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        },
      },
    );

    if (tokenResponseData.status !== 200) {
      const errorText = tokenResponseData.data; // Get error details
      console.error('Error Response:', errorText);
      return res
        .status(500)
        .json({error: 'Failed to exchange code for token', details: errorText});
    }

    const oauthData: RESTPostOAuth2AccessTokenResult = tokenResponseData.data; // Parse the token response
    //console.log('OAuth Data:', oauthData);

    // Send back the token data to the client
    return res.status(200).json({
      access_token: oauthData.access_token,
      refresh_token: oauthData.refresh_token,
      expires_in: oauthData.expires_in,
      scope: oauthData.scope,
      token_type: oauthData.token_type,
    });
  } catch (error) {
    console.error('Error during token exchange:', error);
    return res.status(500).json({error: 'Internal server error'});
  }
});

// Token checking endpoint
router.post('/check-token', async (req: Request, res: Response) => {
  const {accessToken} = req.body;

  const tokenInfo = await verifyAccessToken(accessToken); // Validate token

  if (tokenInfo) {
    return res.json({valid: true, profile: tokenInfo});
  } else {
    return res
      .status(401)
      .json({valid: false, error: 'Invalid or expired token'});
  }
});

router.get('/check-admin', async (req: Request, res: Response) => {
  const accessToken = req.headers.authorization?.split(' ')[1];
  if (!accessToken) {
    return res.status(401).json({ isAdmin: false, isSuperAdmin: false });
  }
  const tokenInfo = await verifyAccessToken(accessToken); // Validate token

  if (tokenInfo) {
    const isRater = await RaterService.isRater(tokenInfo.id);
    const isAdmin = isRater || SUPER_ADMINS.includes(tokenInfo.username);
    const isSuperAdmin = SUPER_ADMINS.includes(tokenInfo.username);
    return res.json({ isAdmin, isSuperAdmin });
  } else {
    return res.status(401).json({ isAdmin: false, isSuperAdmin: false });
  }
});

export default router;
