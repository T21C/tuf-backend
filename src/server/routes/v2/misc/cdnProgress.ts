import { Router, Request, Response } from 'express';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import { errorResponseSchema, standardErrorResponses500 } from '@/server/schemas/v2/misc/index.js';
import { jobProgressService, type JobProgressPatch } from '@/server/services/core/JobProgressService.js';
import { packDownloadJobProgressTtlSeconds } from '@/misc/utils/packDownloadUrlExpiry.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { incrementLevelDownloadCountsForFileIds } from '@/misc/utils/data/levelDownloadCount.js';

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

function requireDownloadIngestKey(req: Request, res: Response): boolean {
  const secret = process.env.DOWNLOAD_INGEST_SECRET;
  if (!secret) {
    logger.error('DOWNLOAD_INGEST_SECRET is not configured');
    res.status(503).json({ error: 'Download ingest not configured' });
    return false;
  }
  const header = req.headers['x-download-ingest-key'];
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
      const ttlSeconds = patch.kind === 'pack_download' ? packDownloadJobProgressTtlSeconds() : undefined;
      const updated = await jobProgressService.patchFromIngest(jobId, patch, ttlSeconds);
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

type DownloadEventKind = 'levelzip' | 'transform';

interface DownloadEventBody {
  fileId: string;
  kind: DownloadEventKind;
}

// POST /v2/cdn/download-events — trusted writers (CDN service) increment per-level
// downloadCount for single-file events (direct level zip + transform). Pack downloads
// are incremented server-side up-front in the pack download route and are NOT
// reported here.
router.post(
  '/download-events',
  ApiDoc({
    operationId: 'postCdnDownloadEvents',
    summary: 'Ingest download events',
    description:
      'Called by the CDN service with header X-Download-Ingest-Key. Increments levels.downloadCount for the single level whose fileId matches the event. Only levelzip / transform events are accepted.',
    tags: ['CDN'],
    requestBody: {
      description: 'Download event payload',
      schema: {
        type: 'object',
        required: ['kind', 'fileId'],
        properties: {
          kind: { type: 'string', enum: ['levelzip', 'transform'] },
          fileId: { type: 'string' },
        },
      },
      required: true,
    },
    responses: {
      200: {
        description: 'Ingest result',
        schema: {
          type: 'object',
          required: ['updatedLevels'],
          properties: {
            updatedLevels: { type: 'number' },
          },
        },
      },
      400: { description: 'Bad request', schema: errorResponseSchema },
      401: { description: 'Unauthorized', schema: errorResponseSchema },
      503: { description: 'Not configured', schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    if (!requireDownloadIngestKey(req, res)) {
      return;
    }

    try {
      const body = req.body as DownloadEventBody;
      const kind = body?.kind;
      if (kind !== 'levelzip' && kind !== 'transform') {
        return res.status(400).json({ error: 'kind must be levelzip or transform' });
      }
      if (!body.fileId || typeof body.fileId !== 'string') {
        return res.status(400).json({ error: 'fileId is required' });
      }

      const updatedLevels = await incrementLevelDownloadCountsForFileIds([body.fileId]);
      return res.status(200).json({ updatedLevels });
    } catch (error) {
      logger.error('postCdnDownloadEvents failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(500).json({ error: 'Failed to process download events' });
    }
  },
);

export default router;
