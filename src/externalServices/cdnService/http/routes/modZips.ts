import {Request, Response, Router} from 'express';
import {logger} from '@/server/services/core/LoggerService.js';
import {cdnLocalTemp} from '@/externalServices/cdnService/infra/workspaces/cdnLocalTempManager.js';
import {CdnIngestUserError} from '@/externalServices/cdnService/jobs/cdnIngestErrors.js';
import {cleanupModZipTemp, ingestModZip} from '@/externalServices/cdnService/services/modZipProcessor.js';

const router = Router();

router.post('/', (req: Request, res: Response) => {
  cdnLocalTemp.modZipUpload(req, res, (err) => {
    const stagedPath = req.file?.path;
    if (err) {
      logger.warn('Mod zip upload rejected', {
        error: err.message,
        code: (err as {code?: string}).code,
      });
      const tooLarge = (err as {code?: string}).code === 'LIMIT_FILE_SIZE';
      res.status(400).json({
        error: tooLarge ? 'Zip must be at most 100 MiB' : err.message,
        code: 'VALIDATION_ERROR',
      });
      return;
    }
    if (!req.file) {
      res.status(400).json({error: 'No file uploaded', code: 'VALIDATION_ERROR'});
      return;
    }

    void ingestModZip({
      filePath: req.file.path,
      originalname: req.file.originalname,
      size: req.file.size,
    })
      .then((result) => {
        cleanupModZipTemp(stagedPath);
        res.status(200).json({
          success: true,
          fileId: result.fileId,
          url: result.url,
          originalFilename: result.originalFilename,
        });
      })
      .catch((error: unknown) => {
        cleanupModZipTemp(stagedPath);
        const message = error instanceof Error ? error.message : 'Invalid zip';
        const userError = error instanceof CdnIngestUserError;
        if (!userError) {
          logger.error('Mod zip ingest failed', {
            error: message,
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
        res.status(400).json({error: message, code: 'VALIDATION_ERROR'});
      });
  });
});

export default router;
