import { Router, Request, Response } from 'express';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { errorResponseSchema, standardErrorResponses500 } from '@/server/schemas/v2/misc/index.js';
import { jobProgressService, type JobProgressPatch } from '@/server/services/JobProgressService.js';
import { logger } from '@/server/services/LoggerService.js';

const router = Router();

interface JobProgressIngestBody extends JobProgressPatch {
  jobId: string;
}

function requireJobIngestKey(req: Request, res: Response): boolean {
  const secret = process.env.JOB_PROGRESS_INGEST_SECRET;
  if (!secret) {
    logger.error('JOB_PROGRESS_INGEST_SECRET is not configured');
    res.status(503).json({ error: 'Job ingest not configured' });
    return false;
  }
  const header = req.headers['x-job-ingest-key'];
  if (typeof header !== 'string' || header !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// POST /v2/cdn/job-progress — trusted writers (CDN service) merge job state into Redis
router.post(
  '/job-progress',
  ApiDoc({
    operationId: 'postCdnJobProgress',
    summary: 'Ingest job progress update',
    description:
      'Called by the CDN service (or other trusted workers) with header X-Job-Ingest-Key. Merges fields into the job document keyed by jobId.',
    tags: ['CDN'],
    requestBody: {
      description: 'Partial job progress (jobId required)',
      schema: {
        type: 'object',
        required: ['jobId'],
        properties: {
          jobId: { type: 'string' },
          kind: { type: 'string' },
          phase: { type: 'string' },
          percent: { type: 'number' },
          message: { type: 'string' },
          meta: { type: 'object', additionalProperties: true },
          error: { type: 'string', nullable: true }
        }
      },
      required: true
    },
    responses: {
      200: {
        description: 'Merged job record',
        schema: { type: 'object', additionalProperties: true }
      },
      400: { description: 'Bad request', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      503: { description: 'Not configured', schema: errorResponseSchema },
      ...standardErrorResponses500
    }
  }),
  async (req: Request, res: Response) => {
    if (!requireJobIngestKey(req, res)) {
      return;
    }

    try {
      const body = req.body as JobProgressIngestBody;
      if (!body?.jobId || typeof body.jobId !== 'string') {
        return res.status(400).json({ error: 'jobId is required' });
      }

      const { jobId, ...patch } = body;
      const updated = await jobProgressService.patchFromIngest(jobId, patch);
      if (!updated) {
        return res.status(500).json({ error: 'Failed to persist job progress' });
      }
      return res.status(200).json(updated);
    } catch (error) {
      logger.error('postCdnJobProgress failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return res.status(500).json({ error: 'Failed to process job progress' });
    }
  }
);

export default router;
