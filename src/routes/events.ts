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
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Enable CORS with credentials
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  res.flushHeaders();

  // Set up keep-alive to prevent connection timeout
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  // Get connection parameters
  const userId = req.query.userId || req.user?.id;
  const source = req.query.source || 'unknown';
  const user = await User.findByPk(userId);
  console.log(user);
  const isManager = user?.isRater || user?.isSuperAdmin || false;

  // Log connection details
  console.debug(`SSE: New connection request from ${isManager ? 'manager' : 'user'}`, {
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
    console.debug(`SSE: Connection closed for client ${clientId}`, {
      userId,
      source,
      isManager
    });
    clearInterval(keepAlive);
    sseManager.removeClient(clientId);
  });
});

export default router;
