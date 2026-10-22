import { formError } from '../shared/errors.js';
import {
  LevelZipSessionError,
  resolveOwnedLevelZipSession,
  type LevelZipSessionPurpose,
  type ResolvedLevelZipSession,
} from '@/server/domain/levels/levelZipSessionIngest.js';

export type { ResolvedLevelZipSession };

/**
 * Look up a level-zip session by id, assert it belongs to the caller, was minted
 * for `purpose`, and is fully assembled.
 *
 * Any mismatch throws a form error with an appropriate status. The returned
 * `assembledPath` is guaranteed to exist on disk at call time.
 */
export async function resolveLevelZipSession(
  sessionId: string,
  userId: string,
  purpose: LevelZipSessionPurpose = 'submission',
): Promise<ResolvedLevelZipSession> {
  try {
    return await resolveOwnedLevelZipSession(sessionId, userId, purpose);
  } catch (err) {
    if (err instanceof LevelZipSessionError) {
      if (err.status === 401) throw formError.unauth(err.message);
      if (err.status === 403) throw formError.forbid(err.message);
      if (err.status === 404) throw formError.notFound(err.message);
      if (err.status === 409) {
        throw formError.conflict(err.message, { field: err.field, details: err.details });
      }
      throw formError.bad(err.message, { field: err.field, details: err.details });
    }
    throw err;
  }
}
