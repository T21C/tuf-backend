import express, { type Request, type Response, type Router, type NextFunction } from 'express';
import cors from 'cors';

import { corsOptions } from '@/config/app.config.js';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  errorResponseSchema,
  standardErrorResponses404500,
  standardErrorResponses500,
  successMessageSchema,
} from '@/server/schemas/v2/misc/index.js';
import { logger } from '@/server/services/core/LoggerService.js';

import {
  UploadError,
  cancelSession,
  completeSession,
  createOrResumeSession,
  getMissingChunks,
  getOwnedSession,
  getUploadKind,
  writeChunk,
} from '@/server/services/upload/UploadSessionService.js';

const router: Router = express.Router();

router.use(cors(corsOptions));
router.use(Auth.verified());

function sendError(res: Response, err: unknown, fallback = 'Upload error'): void {
  if (err instanceof UploadError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  logger.error(fallback, err);
  res.status(500).json({ error: fallback });
}

/** Shape of a session as returned to clients. Excludes disk paths / workspace dir. */
function serialiseSession(session: import('@/models/upload/UploadSession.js').default) {
  return {
    id: session.id,
    kind: session.kind,
    status: session.status,
    originalName: session.originalName,
    mimeType: session.mimeType,
    declaredSize: Number(session.declaredSize),
    declaredHash: session.declaredHash,
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    receivedChunks: session.receivedChunks,
    missingChunks: getMissingChunks(session),
    assembledHash: session.assembledHash,
    result: session.result,
    errorMessage: session.errorMessage,
    expiresAt: session.expiresAt,
  };
}

router.post(
  '/init',
  ApiDoc({
    operationId: 'postUploadInit',
    summary: 'Create or resume a chunked upload session',
    description:
      'Create a new upload session for the given kind, or resume an equivalent one for this user. ' +
      'Filenames travel as UTF-8 JSON strings; the server NFC-normalises them. The client MUST supply ' +
      'a hex-encoded sha256 of the full file, which is verified at /complete.',
    tags: ['Upload'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'Upload session init body',
      required: true,
      schema: {
        type: 'object',
        required: ['kind', 'originalName', 'declaredSize', 'declaredHash', 'chunkSize'],
        properties: {
          kind: { type: 'string' },
          originalName: { type: 'string' },
          mimeType: { type: 'string', nullable: true },
          declaredSize: { type: 'integer' },
          declaredHash: { type: 'string', description: 'hex sha256' },
          chunkSize: { type: 'integer' },
          meta: { type: 'object', nullable: true },
        },
      },
    },
    responses: {
      200: { description: 'Session created or resumed' },
      400: { schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const body = req.body ?? {};
      const result = await createOrResumeSession({
        req,
        kindId: String(body.kind ?? ''),
        originalName: String(body.originalName ?? ''),
        mimeType: body.mimeType == null ? null : String(body.mimeType),
        declaredSize: Number(body.declaredSize),
        declaredHash: String(body.declaredHash ?? ''),
        chunkSize: Number(body.chunkSize),
        meta: body.meta,
      });
      res.json({
        session: serialiseSession(result.session),
        resumed: result.resumed,
      });
    } catch (err) {
      sendError(res, err, 'Upload init failed');
    }
  },
);

router.get(
  '/kinds/:kind',
  ApiDoc({
    operationId: 'getUploadKind',
    summary: 'Describe an upload kind',
    description: 'Returns the size + chunk limits advertised by the server for an upload kind.',
    tags: ['Upload'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Kind descriptor' },
      404: { schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  (req: Request, res: Response) => {
    const kind = getUploadKind(req.params.kind);
    if (!kind) {
      res.status(404).json({ error: 'Unknown kind' });
      return;
    }
    res.json({
      id: kind.id,
      maxFileSize: kind.maxFileSize,
      chunkSize: kind.chunkSize,
      allowedMimeTypes: kind.allowedMimeTypes ?? null,
    });
  },
);

// Raw-bytes endpoint: one chunk per request. Content-Type can be anything — we
// care only about the body. Content-Length is enforced by express limit.
// An explicit middleware keeps the request body stream buffered.
router.post(
  '/sessions/:id/chunks/:index',
  express.raw({
    type: () => true,
    limit: '64mb',
  }),
  ApiDoc({
    operationId: 'postUploadChunk',
    summary: 'Upload one chunk of a session',
    description:
      'Raw binary body. Index is zero-based and must be in [0, totalChunks). The chunk size must match ' +
      'the session\'s declared chunkSize (last chunk may be smaller).',
    tags: ['Upload'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Chunk accepted' },
      400: { schema: errorResponseSchema },
      403: { schema: errorResponseSchema },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) throw new UploadError(401, 'Authentication required');
      const session = await getOwnedSession(req.params.id, userId);
      const index = Number.parseInt(req.params.index, 10);
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        throw new UploadError(400, 'Empty chunk body');
      }
      const updated = await writeChunk({ session, index, data: body });
      res.json({
        sessionId: updated.id,
        receivedChunks: updated.receivedChunks.length,
        totalChunks: updated.totalChunks,
      });
    } catch (err) {
      sendError(res, err, 'Chunk upload failed');
    }
  },
);

router.post(
  '/sessions/:id/complete',
  ApiDoc({
    operationId: 'postUploadComplete',
    summary: 'Assemble + finalise an upload session',
    description:
      'Concatenates received chunks, verifies sha256 against the declared hash, and runs the ' +
      'kind\'s onAssembled hook. Idempotent.',
    tags: ['Upload'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Assembled' },
      409: { schema: errorResponseSchema },
      ...standardErrorResponses404500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) throw new UploadError(401, 'Authentication required');
      const session = await getOwnedSession(req.params.id, userId);
      const finalised = await completeSession(session);
      res.json({ session: serialiseSession(finalised) });
    } catch (err) {
      sendError(res, err, 'Upload complete failed');
    }
  },
);

router.get(
  '/sessions/:id',
  ApiDoc({
    operationId: 'getUploadSession',
    summary: 'Get upload session status',
    description: 'Returns the current status, received chunks and missing chunks for resume.',
    tags: ['Upload'],
    security: ['bearerAuth'],
    responses: {
      200: { description: 'Session state' },
      404: { schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) throw new UploadError(401, 'Authentication required');
      const session = await getOwnedSession(req.params.id, userId);
      res.json({ session: serialiseSession(session) });
    } catch (err) {
      sendError(res, err, 'Upload status failed');
    }
  },
);

router.delete(
  '/sessions/:id',
  ApiDoc({
    operationId: 'deleteUploadSession',
    summary: 'Cancel + delete an upload session',
    description: 'Destroys the session row and its workspace on disk. Idempotent.',
    tags: ['Upload'],
    security: ['bearerAuth'],
    responses: {
      200: { schema: successMessageSchema },
      404: { schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) throw new UploadError(401, 'Authentication required');
      const session = await getOwnedSession(req.params.id, userId);
      await cancelSession(session);
      res.json({ message: 'Upload session cancelled' });
    } catch (err) {
      sendError(res, err, 'Upload cancel failed');
    }
  },
);

export default router;
