import { Router, Request, Response } from 'express';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { Auth } from '@/server/middleware/auth.js';
import { errorResponseSchema, standardErrorResponses500 } from '@/server/schemas/v2/misc/index.js';
import {
  jobProgressRedisChannel,
  jobProgressService,
  isUuidJobId,
  type JobProgressRecord
} from '@/server/services/core/JobProgressService.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { redis } from '@/server/services/core/RedisService.js';
import { clientUrlEnv } from '@/config/app.config.js';

const router = Router();

function applyJobStreamCors(req: Request, res: Response): void {
  const origin = req.headers.origin;
  const allowedOrigins = [clientUrlEnv, 'https://tuforums.com', 'https://api.tuforums.com'];

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', clientUrlEnv || 'http://localhost:5173');
  }

  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    ['Content-Type', 'Authorization', 'Cache-Control', 'Last-Event-ID', 'X-Form-Type', 'X-Super-Admin-Password'].join(
      ', '
    )
  );
}

router.get(
  '/:jobId/stream',
  Auth.verified(),
  ApiDoc({
    operationId: 'streamJobProgress',
    summary: 'Stream async job progress (SSE)',
    description:
      'Server-Sent Events stream of job progress updates for the given job ID. Same ownership rules as GET /v2/jobs/:jobId. Sends an initial snapshot if the job exists, otherwise `{"type":"waiting"}` until the first Redis update.',
    tags: ['Jobs'],
    security: ['bearerAuth'],
    params: {
      jobId: {
        description: 'Job UUID',
        schema: { type: 'string', format: 'uuid' }
      }
    },
    responses: {
      200: { description: 'text/event-stream' },
      400: { description: 'Invalid job id', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      403: { description: 'Forbidden', schema: errorResponseSchema },
      503: { description: 'Progress stream unavailable', schema: errorResponseSchema },
      ...standardErrorResponses500
    }
  }),
  async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;
      if (!jobId || typeof jobId !== 'string' || !isUuidJobId(jobId)) {
        return res.status(400).json({ error: 'Invalid job id' });
      }

      const initial = await jobProgressService.get(jobId);
      if (initial && !jobProgressService.canUserRead(initial, req.user?.id)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const sub = await redis.createSubscriberClient();
      if (!sub) {
        return res.status(503).json({ error: 'Progress stream unavailable' });
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      applyJobStreamCors(req, res);
      res.flushHeaders();

      const channel = jobProgressRedisChannel(jobId);
      let cleaned = false;

      const cleanup = async (): Promise<void> => {
        if (cleaned) {
          return;
        }
        cleaned = true;
        try {
          await sub.unsubscribe(channel);
        } catch {
          /* noop */
        }
        try {
          await sub.quit();
        } catch {
          /* noop */
        }
      };

      const keepAlive = setInterval(() => {
        try {
          res.write(': keepalive\n\n');
        } catch {
          /* noop */
        }
      }, 15000);

      const sendSse = (payload: unknown) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const finish = () => {
        clearInterval(keepAlive);
        void cleanup().finally(() => {
          try {
            if (!res.writableEnded) {
              res.end();
            }
          } catch {
            /* noop */
          }
        });
      };

      const sendJobIfReadable = (rec: JobProgressRecord): boolean => {
        if (!jobProgressService.canUserRead(rec, req.user?.id)) {
          finish();
          return false;
        }
        sendSse({ type: 'job', data: rec });
        return true;
      };

      res.on('close', () => {
        clearInterval(keepAlive);
        void cleanup();
      });

      if (initial) {
        sendJobIfReadable(initial);
        if (initial.phase === 'completed' || initial.phase === 'failed') {
          finish();
          return;
        }
      } else {
        sendSse({ type: 'waiting' });
      }

      await sub.subscribe(channel, (message: string) => {
        try {
          const parsed = JSON.parse(message) as { type?: string; data?: JobProgressRecord };
          if (parsed?.type !== 'job' || !parsed.data) {
            return;
          }
          if (!sendJobIfReadable(parsed.data)) {
            return;
          }
          if (parsed.data.phase === 'completed' || parsed.data.phase === 'failed') {
            finish();
          }
        } catch (e) {
          logger.warn('job progress stream: bad pub message', {
            jobId,
            error: e instanceof Error ? e.message : String(e)
          });
        }
      });

      return undefined;
    } catch (error) {
      logger.error('streamJobProgress failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Failed to open progress stream' });
      }
      return undefined;
    }
  }
);

router.get(
  '/:jobId',
  Auth.verified(),
  ApiDoc({
    operationId: 'getJobProgress',
    summary: 'Get async job progress',
    description: 'Returns the Redis-backed job document for the given job ID. Caller must own the job (ownerUserId set at creation).',
    tags: ['Jobs'],
    security: ['bearerAuth'],
    params: {
      jobId: {
        description: 'Job UUID',
        schema: { type: 'string', format: 'uuid' }
      }
    },
    responses: {
      200: { description: 'Job progress document' },
      403: { description: 'Forbidden', schema: errorResponseSchema },
      404: { description: 'Job not found', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      ...standardErrorResponses500
    }
  }),
  async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;
      if (!jobId || typeof jobId !== 'string') {
        return res.status(400).json({ error: 'Invalid job id' });
      }

      const record = await jobProgressService.get(jobId);
      if (!record) {
        return res.status(404).json({ error: 'Job not found' });
      }

      if (!jobProgressService.canUserRead(record, req.user?.id)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      return res.status(200).json(record);
    } catch (error) {
      logger.error('getJobProgress failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return res.status(500).json({ error: 'Failed to load job progress' });
    }
  }
);

export default router;
