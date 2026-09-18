import { Router, Request, Response } from 'express';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  errorResponseSchema,
  standardErrorResponses403404500,
  standardErrorResponses500,
  stringIdParamSpec,
} from '@/server/schemas/v2/admin/index.js';
import {
  handlePostSubmissionZipUpload,
  handlePostSubmissionZipUploadFromUrl,
  handlePostSubmissionSelectLevel,
  handlePostSubmissionReparseChart,
} from '@/server/domain/submissions/submissionZipUploadHandlers.js';

const router: Router = Router();

router.post(
  '/levels/:id/upload',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postAdminLevelSubmissionUpload',
    summary: 'Replace pending submission zip (chunked session)',
    description:
      'Finalize a level zip from an assembled `level-zip` upload session onto a pending level submission. Super admin. Optional `uploadJobId` for GET /v2/jobs/:jobId progress.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
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
    void handlePostSubmissionZipUpload(req, res);
  },
);

router.post(
  '/levels/:id/upload-from-url',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postAdminLevelSubmissionUploadFromUrl',
    summary: 'Replace pending submission zip from URL or Steam Workshop',
    description:
      'Super admin only. Direct http(s) archive URL (including Google Drive view links), or a Steam Workshop item URL / steam://url/CommunityFilePage/{id}. Updates LevelSubmission.directDL like POST .../upload.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
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
    void handlePostSubmissionZipUploadFromUrl(req, res);
  },
);

router.post(
  '/levels/:id/select-level',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postAdminLevelSubmissionSelectLevel',
    summary: 'Select chart in pending submission zip',
    description: 'Set target .adofai in the CDN zip for a pending level submission. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
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
    void handlePostSubmissionSelectLevel(req, res);
  },
);

router.post(
  '/levels/:id/reparse-chart',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'postAdminLevelSubmissionReparseChart',
    summary: 'Reparse pending submission chart cache',
    description:
      'Clear and rebuild the CDN chart cache for the current target file. Does not write Level rows. Super admin.',
    tags: ['Admin', 'Submissions'],
    security: ['bearerAuth'],
    params: { id: stringIdParamSpec },
    responses: {
      200: { description: 'Chart reparsed' },
      400: { schema: errorResponseSchema },
      ...standardErrorResponses403404500,
    },
  }),
  (req: Request, res: Response) => {
    void handlePostSubmissionReparseChart(req, res);
  },
);

export default router;
