import {Router} from 'express';
import {sseManager} from '../utils/sse.js';
import {Auth} from '../middleware/auth.js';
import {Request, Response} from 'express';
import User from '../models/User.js';

const router: Router = Router();

interface SSERequest extends Request {
  query: {
    userId?: string;
    source?: string;
    isManager?: string;
  };
}

// SSE endpoint
router.get('/', async (req: SSERequest, res: Response) => {
  // Get environment-specific client URL
  const clientUrlEnv = process.env.NODE_ENV === 'production'
    ? process.env.PROD_CLIENT_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_CLIENT_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.CLIENT_URL
        : 'http://localhost:5173';

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Set CORS headers matching main app configuration
  const origin = req.headers.origin;
  const allowedOrigins = [
    clientUrlEnv,
    'https://tuforums.com',
    'https://api.tuforums.com'
  ];

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', clientUrlEnv || 'http://localhost:5173');
  }
  
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', [
    'Content-Type',
    'Authorization',
    'Cache-Control',
    'Last-Event-ID',
    'X-Form-Type',
    'X-Super-Admin-Password'
  ].join(', '));
  res.setHeader('Access-Control-Expose-Headers', [
    'Content-Type',
    'Authorization',
    'Cache-Control',
    'Last-Event-ID',
    'X-Form-Type',
    'X-Super-Admin-Password'
  ].join(', '));

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  res.flushHeaders();

  // Set up keep-alive to prevent connection timeout
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  // Get connection parameters
  const userId = req.query.userId || req.user?.id;
  const source = req.query.source || 'unknown';
  const user = await User.findByPk(userId);
  const isManager = user?.isRater || user?.isSuperAdmin || false;

  // Log connection details
  console.debug(`SSE Rating: New connection request from ${isManager ? 'manager' : 'user'}`, {
    userId,
    source,
  });

  // Add client to SSE manager
  const clientId = sseManager.addClient(res, {
    userId: userId as string,
    source,
    isManager
  });

  // Clean up on connection close
  res.on('close', () => {
    console.debug(`SSE Rating: Connection closed for client ${clientId}`, {
      userId,
      source,
      isManager
    });
    clearInterval(keepAlive);
    sseManager.removeClient(clientId);
  });
});

export default router;
