import fs from 'fs';
import type UploadSession from '@/models/upload/UploadSession.js';
import {
  UploadError,
  getOwnedSession,
} from '@/server/services/upload/UploadSessionService.js';

import { FormError, formError } from '../shared/errors.js';

export interface ResolvedLevelZipSession {
  session: UploadSession;
  assembledPath: string;
  originalName: string;
}

/**
 * Look up a level-zip session by id, assert it belongs to the caller, was minted
 * for a new submission (meta.forSubmission === true), and is fully assembled.
 *
 * Any mismatch throws a {@link FormError} with an appropriate status. The
 * returned `assembledPath` is guaranteed to exist on disk at call time.
 */
export async function resolveLevelZipSession(
  sessionId: string,
  userId: string,
): Promise<ResolvedLevelZipSession> {
  if (!sessionId || typeof sessionId !== 'string') {
    throw formError.bad('Invalid uploadSessionId', { field: 'uploadSessionId' });
  }

  let session: UploadSession;
  try {
    session = await getOwnedSession(sessionId, userId);
  } catch (err) {
    if (err instanceof UploadError) {
      throw new FormError(err.status, err.message, { field: 'uploadSessionId' });
    }
    throw err;
  }

  if (session.kind !== 'level-zip') {
    throw formError.bad('Upload session is not a level-zip session', {
      field: 'uploadSessionId',
      details: { kind: session.kind },
    });
  }

  const forSubmission = session.meta?.forSubmission === true;
  if (!forSubmission) {
    throw formError.forbid('Upload session was not created for a new submission');
  }

  if (session.status !== 'assembled' || !session.assembledPath) {
    throw formError.conflict(`Upload session is not assembled (status: ${session.status})`);
  }

  try {
    await fs.promises.access(session.assembledPath, fs.constants.R_OK);
  } catch {
    throw formError.conflict('Assembled zip file is missing on disk');
  }

  return {
    session,
    assembledPath: session.assembledPath,
    originalName: session.originalName,
  };
}
