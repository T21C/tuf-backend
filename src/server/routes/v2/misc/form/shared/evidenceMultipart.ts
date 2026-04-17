import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import multer from 'multer';

import { WORKSPACE_ROOT } from '@/server/services/core/WorkspaceService.js';

/**
 * Multer destination lives under the shared workspace root so stale evidence
 * files from killed processes are swept at boot. The directory is (re)created
 * lazily per upload because the workspace sweep runs after module import.
 *
 * Filenames are UUID-prefixed so concurrent uploads never clash and malicious
 * originalnames can't stomp each other. `file.originalname` is preserved for
 * downstream consumers (EvidenceService).
 */
export const FORM_UPLOAD_DIR = path.join(WORKSPACE_ROOT, 'form-upload');

const MAX_EVIDENCE_FILES = 10;
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

export const evidenceMultipart = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdir(FORM_UPLOAD_DIR, { recursive: true }, (err) => {
        if (err) cb(err, FORM_UPLOAD_DIR);
        else cb(null, FORM_UPLOAD_DIR);
      });
    },
    filename: (_req, file, cb) => {
      cb(null, `${crypto.randomUUID()}-${path.basename(file.originalname)}`);
    },
  }),
  limits: { fileSize: MAX_EVIDENCE_BYTES, files: MAX_EVIDENCE_FILES },
}).array('evidence', MAX_EVIDENCE_FILES);

export const EVIDENCE_LIMITS = {
  maxFiles: MAX_EVIDENCE_FILES,
  maxBytes: MAX_EVIDENCE_BYTES,
} as const;

/** Silently unlink evidence tempfiles in a finally block. */
export async function cleanupEvidenceTempfiles(files: Express.Multer.File[] | undefined): Promise<void> {
  if (!files || files.length === 0) return;
  await Promise.all(
    files.map(async (f) => {
      if (!f.path) return;
      try {
        await fs.promises.unlink(f.path);
      } catch {
        /* ignore */
      }
    }),
  );
}
