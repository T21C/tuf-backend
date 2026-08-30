import fs from 'fs';
import os from 'os';
import path from 'path';
import {randomUUID} from 'crypto';
import type {NextFunction, Request, Response} from 'express';
import multer from 'multer';
import {withUtf8Filenames} from '@/misc/utils/multipartFilename.js';
import {MOD_ZIP_MAX_BYTES} from '@/server/services/mods/modZipLimits.js';

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, os.tmpdir()),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.zip';
    cb(null, `mod-zip-${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {fileSize: MOD_ZIP_MAX_BYTES},
});

const uploadSingle = withUtf8Filenames(upload.single('file'));

export function unlinkModZipUpload(file: Express.Multer.File | undefined): void {
  if (!file?.path) return;
  fs.promises.unlink(file.path).catch(() => undefined);
}

export function multerModZipSingle(req: Request, res: Response, next: NextFunction): void {
  uploadSingle(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    const code = err && typeof err === 'object' && 'code' in err ? String((err as {code: string}).code) : '';
    if (code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({error: 'Zip must be at most 100 MiB'});
      return;
    }
    const message = err instanceof Error ? err.message : 'Upload failed';
    res.status(400).json({error: message});
  });
}
