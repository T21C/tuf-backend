import {Router} from 'express';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {sseManager} from '@/misc/utils/server/sse.js';
import {Request, Response} from 'express';
import { clientUrlEnv, isAllowedCorsOrigin } from '@/config/app.config.js';
import { permissionFlags } from '@/config/constants.js';
import { hasAnyFlag } from '@/misc/utils/auth/permissionUtils.js';
import { Auth } from '@/server/middleware/auth.js';

const router: Router = Router();

interface SSERequest extends Request {
  query: {
    userId?: string;
    source?: string;
    isManager?: string;
  };
}

// SSE endpoint
router.get(
  '/',
  Auth.tryUser(),
  ApiDoc({
    operationId: 'getEventsSSE',
    summary: 'SSE stream',
    description: 'Server-Sent Events stream for real-time updates (e.g. rating room user counts, inbox notifications). Query: source. Authenticated user id is taken from the session, not the query string. Response is text/event-stream; connection stays open.',
    tags: ['Events'],
    query: {
      source: { description: 'Client source identifier', schema: { type: 'string' } },
    },
    responses: {
      200: { description: 'Event stream (text/event-stream)' },
      204: { description: 'OPTIONS preflight' },
    },
  }),
  async (req: SSERequest, res: Response) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Set CORS headers matching main app configuration
  const origin = req.headers.origin;
  if (origin && isAllowedCorsOrigin(origin)) {
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
    'X-Super-Admin-Proof',
    'baggage',
    'sentry-trace',
  ].join(', '));
  res.setHeader('Access-Control-Expose-Headers', [
    'Content-Type',
    'Authorization',
    'Cache-Control',
    'Last-Event-ID',
    'X-Form-Type',
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

  // Get connection parameters from the authenticated session only
  const userId = req.user?.id ?? null;
  const source = req.query.source || 'unknown';
  const isManager = hasAnyFlag(req.user, [permissionFlags.RATER, permissionFlags.SUPER_ADMIN]);

  // Add client to SSE manager
  const clientId = sseManager.addClient(res, {
    userId,
    source,
    isManager
  });

  // Clean up on connection close
  res.on('close', () => {
    clearInterval(keepAlive);
    sseManager.removeClient(clientId);
  });
  }
);

export default router;
