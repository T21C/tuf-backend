import { Router, Request, Response } from 'express';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  errorResponseSchema,
  idParamSpec,
  standardErrorResponses403404500,
  standardErrorResponses500,
} from '@/server/schemas/common.js';
import {
  handlePostLevelZipUpload,
  handlePostLevelZipUploadFromUrl,
  handlePostLevelSelectLevel,
  handleDeleteLevelZipUpload,
} from '@/server/domain/levels/levelZipUploadHandlers.js';

const router: Router = Router();

router.post(
  '/:id([0-9]{1,20})/upload',
  Auth.verified(),
  ApiDoc({
    operationId: 'v3PostLevelUpload',
    summary: 'Upload level file (chunked session)',
    description:
      'Finalize a level zip from an assembled `level-zip` upload session. Creator or super admin. Optional `uploadJobId` for GET /v2/jobs/:jobId progress.',
    tags: ['Database', 'Levels', 'v3'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: {
      description: 'sessionId from chunked upload; optional uploadJobId (UUID) for job progress',
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          uploadJobId: { type: 'string', format: 'uuid' },
        },
        required: ['sessionId'],
      },
      required: true,
    },
    responses: {
      200: { description: 'Upload success' },
      202: { description: 'Accepted — processing continues; poll GET /v2/jobs/:uploadJobId or SSE stream' },
      400: { schema: errorResponseSchema },
      403: { schema: errorResponseSchema },
      404: { schema: errorResponseSchema },
      409: { schema: errorResponseSchema },
      499: { schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  (req: Request, res: Response) => {
    void handlePostLevelZipUpload(req, res);
  },
);

router.post(
  '/:id([0-9]{1,20})/upload-from-url',
  Auth.verified(),
  ApiDoc({
    operationId: 'v3PostLevelUploadFromUrl',
    summary: 'Upload level zip from URL or Steam Workshop',
    description:
      'Super admin only. Accepts a direct http(s) archive URL (including Google Drive view links), or a Steam Workshop item URL / steam://url/CommunityFilePage/{id}. Workshop imports require SteamCMD on the server (STEAMCMD_PATH). Validates the archive, uploads to CDN, and updates the level like POST /upload.',
    tags: ['Database', 'Levels', 'v3'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: {
      description:
        'Direct download URL for an archive, or a Steam Workshop filedetails / steam:// CommunityFilePage link',
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          uploadJobId: { type: 'string', format: 'uuid' },
        },
        required: ['url'],
      },
      required: true,
    },
    responses: {
      200: { description: 'Upload success' },
      202: { description: 'Accepted — CDN processing continues; poll job progress' },
      400: { schema: errorResponseSchema },
      403: { schema: errorResponseSchema },
      404: { schema: errorResponseSchema },
      409: { schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  (req: Request, res: Response) => {
    void handlePostLevelZipUploadFromUrl(req, res);
  },
);

router.post(
  '/:id([0-9]{1,20})/select-level',
  Auth.verified(),
  ApiDoc({
    operationId: 'v3PostLevelSelectLevel',
    summary: 'Select level file',
    description: 'Set target level index for a CDN level file. Creator or super admin.',
    tags: ['Database', 'Levels', 'v3'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    requestBody: {
      description: 'selectedLevel: full path or relative path string',
      schema: { type: 'object', properties: { selectedLevel: { type: 'string' } }, required: ['selectedLevel'] },
      required: true,
    },
    responses: {
      200: { description: 'Level selected' },
      400: { schema: errorResponseSchema },
      ...standardErrorResponses403404500,
    },
  }),
  (req: Request, res: Response) => {
    void handlePostLevelSelectLevel(req, res);
  },
);

router.delete(
  '/:id([0-9]{1,20})/upload',
  Auth.verified(),
  ApiDoc({
    operationId: 'v3DeleteLevelUpload',
    summary: 'Delete level file',
    description: 'Remove CDN level file and clear dlLink. Creator or super admin.',
    tags: ['Database', 'Levels', 'v3'],
    security: ['bearerAuth'],
    params: { id: idParamSpec },
    responses: {
      200: { description: 'File removed' },
      400: { schema: errorResponseSchema },
      ...standardErrorResponses403404500,
    },
  }),
  (req: Request, res: Response) => {
    void handleDeleteLevelZipUpload(req, res);
  },
);

export default router;
