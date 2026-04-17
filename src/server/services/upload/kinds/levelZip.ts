import { UploadError, type UploadKind } from '@/server/services/upload/UploadSessionService.js';
import Level from '@/models/levels/Level.js';
import sequelize from '@/config/db.js';
import { checkLevelOwnership } from '@/server/routes/v2/database/levels/modification.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';

export interface LevelZipMeta {
  /** Level being replaced. If null, the upload is for a new submission (validated at /init). */
  levelId: number | null;
  /** True when the session was minted by `POST /v2/form/level/validate` for a brand-new submission. */
  forSubmission?: boolean;
}

export interface LevelZipResult {
  /** Absolute path to the assembled .zip in the session workspace. Consumed by /levels/:id/upload. */
  assembledPath: string;
}

/**
 * Level zip upload kind: enforces ownership on the target level (if any) at init time and
 * leaves the assembled file on disk for the legacy finalize endpoint to consume.
 *
 * The heavy lifting (CDN upload, duration validation, job-progress updates) still lives in
 * the level modification routes; this kind just gates the transport and hands over
 * `assembledPath`.
 */
export const LevelZipUploadKind: UploadKind<LevelZipMeta, LevelZipResult> = {
  id: 'level-zip',
  workspaceDomain: 'chunked-upload',
  // 2 GiB hard cap — level zips are small but the cap protects the disk.
  maxFileSize: 2 * 1024 * 1024 * 1024,
  chunkSize: { min: 64 * 1024, max: 16 * 1024 * 1024 },
  sessionTtlMs: 24 * 60 * 60 * 1000,

  async validateInit({ req, meta: rawMeta }) {
    const user = req.user;
    if (!user) throw new UploadError(401, 'Authentication required');

    const metaObj = (rawMeta && typeof rawMeta === 'object' ? rawMeta : {}) as Record<string, unknown>;
    const rawLevelId = metaObj.levelId;
    const levelId =
      rawLevelId == null || rawLevelId === ''
        ? null
        : Number(rawLevelId);
    const forSubmission = metaObj.forSubmission === true || metaObj.forSubmission === 'true';

    if (levelId == null) {
      // "New submission" path: require the submission gate. This matches the
      // checks run by `/v2/form/level/validate` so a replay of /init that
      // bypasses the form endpoint still goes through the same guardrails.
      if (!forSubmission) {
        throw new UploadError(400, 'Missing levelId (or set meta.forSubmission to true for new submissions)');
      }
      if (hasFlag(user, permissionFlags.BANNED)) throw new UploadError(403, 'You are banned');
      if (hasFlag(user, permissionFlags.SUBMISSIONS_PAUSED)) throw new UploadError(403, 'Your submissions are paused');
      if (!hasFlag(user, permissionFlags.EMAIL_VERIFIED)) throw new UploadError(403, 'Your email is not verified');
      return { meta: { levelId: null, forSubmission: true } };
    }

    if (!Number.isInteger(levelId) || levelId <= 0) {
      throw new UploadError(400, 'Invalid levelId in meta');
    }

    const transaction = await sequelize.transaction();
    try {
      const level = await Level.findByPk(levelId, { transaction });
      if (!level) {
        await transaction.rollback();
        throw new UploadError(404, 'Level not found');
      }
      const { canEdit, errorMessage } = await checkLevelOwnership(levelId, req.user, transaction);
      if (!canEdit) {
        await transaction.rollback();
        throw new UploadError(403, errorMessage ?? 'Forbidden');
      }
      await transaction.commit();
    } catch (err) {
      try { await transaction.rollback(); } catch { /* already rolled back */ }
      if (err instanceof UploadError) throw err;
      logger.warn('level-zip validateInit ownership check failed:', err);
      throw new UploadError(500, 'Failed to verify level access');
    }
    return { meta: { levelId, forSubmission: false } };
  },

  async onAssembled({ assembledPath }) {
    return { assembledPath };
  },
};
