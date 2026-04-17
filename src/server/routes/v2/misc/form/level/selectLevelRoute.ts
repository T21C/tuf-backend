import express, { Router, type Request, type Response } from 'express';

import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import cdnService, { CdnError } from '@/server/services/core/CdnService.js';
import { Auth } from '@/server/middleware/auth.js';
import { ApiDoc } from '@/server/middleware/apiDoc.js';
import {
  errorResponseSchema,
  standardErrorResponses500,
} from '@/server/schemas/v2/misc/index.js';
import { logger } from '@/server/services/core/LoggerService.js';

const router: Router = Router();

/**
 * Lets the client pick a specific `.adofai` from a multi-chart zip after
 * `POST /level/submit` returns `requiresLevelSelection: true`. Logic was moved
 * verbatim from the old `/v2/form/select-level` endpoint.
 */
router.post(
  '/select-level',
  Auth.verified(),
  express.json(),
  ApiDoc({
    operationId: 'postFormLevelSelectLevel',
    summary: 'Select level chart for submission',
    description: 'Link a selected chart from a multi-chart zip to a submission.',
    tags: ['Form'],
    security: ['bearerAuth'],
    requestBody: {
      description: 'submissionId, selectedLevel',
      schema: {
        type: 'object',
        properties: {
          submissionId: { type: 'integer' },
          selectedLevel: { type: 'string' },
        },
        required: ['submissionId', 'selectedLevel'],
      },
      required: true,
    },
    responses: {
      200: { description: 'OK' },
      400: { schema: errorResponseSchema },
      401: { schema: errorResponseSchema },
      404: { schema: errorResponseSchema },
      ...standardErrorResponses500,
    },
  }),
  async (req: Request, res: Response) => {
    const { submissionId, selectedLevel } = req.body;

    if (!submissionId || !selectedLevel) {
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    const parsedSubmissionId = parseInt(submissionId);
    if (Number.isNaN(parsedSubmissionId) || parsedSubmissionId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid submission ID' });
    }

    if (typeof selectedLevel !== 'string' || selectedLevel.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid selected level' });
    }

    try {
      const submission = await LevelSubmission.findOne({
        where: {
          id: parsedSubmissionId,
          userId: req.user?.id,
          status: 'pending',
        },
      });

      if (!submission) {
        return res.status(404).json({ success: false, error: 'Level submission not found' });
      }

      if (!submission.directDL || !submission.directDL.includes('/')) {
        return res.status(400).json({
          success: false,
          error: 'Invalid directDL URL',
          directDL: submission.directDL,
        });
      }

      const urlParts = submission.directDL.split('/');
      const fileId = urlParts[urlParts.length - 1] || '';
      if (!fileId) {
        return res.status(400).json({
          success: false,
          error: 'Invalid directDL URL - could not extract file ID',
          directDL: submission.directDL,
        });
      }

      const levelFiles = await cdnService.getLevelFiles(fileId);
      const normalizedSelectedLevel = String(selectedLevel).replace(/\\/g, '/').replace(/^\/+/, '');
      const selectedFile = levelFiles.find((file) => {
        const normalizedFullPath = (file.fullPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const normalizedRelativePath = (file.relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        return (
          normalizedFullPath === normalizedSelectedLevel ||
          normalizedRelativePath === normalizedSelectedLevel ||
          file.name === selectedLevel
        );
      });

      if (!selectedFile) {
        logger.error('Selected level file not found:', {
          fileId,
          selectedLevel,
          availableFiles: levelFiles.map((f) => f.fullPath || f.relativePath || f.name),
          timestamp: new Date().toISOString(),
        });
        return res.status(400).json({
          success: false,
          error: 'Selected level file not found',
          availableFiles: levelFiles.map((f) => f.fullPath || f.relativePath || f.name),
        });
      }

      await cdnService.setTargetLevel(fileId, selectedLevel);

      return res.json({
        success: true,
        selectedFile: {
          name: selectedFile.name,
          size: selectedFile.size,
          hasYouTubeStream: selectedFile.hasYouTubeStream,
          songFilename: selectedFile.songFilename,
          artist: selectedFile.artist,
          song: selectedFile.song,
          author: selectedFile.author,
          difficulty: selectedFile.difficulty,
          bpm: selectedFile.bpm,
        },
      });
    } catch (error) {
      logger.error('Failed to process level selection:', {
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
        submissionId: parsedSubmissionId,
        selectedLevel,
        userId: req.user?.id,
        timestamp: new Date().toISOString(),
      });

      if (error instanceof CdnError) {
        return res.status(400).json({
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        });
      }

      return res.status(500).json({
        success: false,
        error: 'Failed to process level selection',
      });
    }
  },
);

export default router;
