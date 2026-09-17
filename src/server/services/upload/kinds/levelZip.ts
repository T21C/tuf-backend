import { UploadError, type UploadKind } from '@/server/services/upload/UploadSessionService.js';
import Level from '@/models/levels/Level.js';
import LevelSubmission from '@/models/submissions/LevelSubmission.js';
import sequelize from '@/config/db.js';
import { checkLevelOwnership } from '@/server/domain/levels/levelOwnership.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { hasFlag } from '@/misc/utils/auth/permissionUtils.js';
import { permissionFlags } from '@/config/constants.js';
import { isPermissionBanActive } from '@/server/services/accounts/playerBanUtils.js';
import { SubmissionJobService } from '@/server/services/submissions/SubmissionJobService.js';
import { shouldSkipEnqueue } from '@/server/services/submissions/submissionJobTypes.js';
import {
  LEVEL_ZIP_MAX_FILE_SIZE_BYTES,
} from '@/server/services/upload/kinds/levelZipLimits.js';

export interface LevelZipMeta {
  /** Level being replaced. If null, the upload is for a new submission (validated at /init). */
  levelId: number | null;
  /** True when the session was minted by `POST /v2/form/level/validate` for a brand-new submission. */
  forSubmission?: boolean;
  /** Pending level submission whose zip a super-admin is replacing. */
  submissionId?: number | null;
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
  maxFileSize: LEVEL_ZIP_MAX_FILE_SIZE_BYTES,
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
    const rawSubmissionId = metaObj.submissionId;
    const submissionId =
      rawSubmissionId == null || rawSubmissionId === ''
        ? null
        : Number(rawSubmissionId);

    if (submissionId != null) {
      if (levelId != null || forSubmission) {
        throw new UploadError(400, 'submissionId cannot be combined with levelId or forSubmission');
      }
      if (!hasFlag(user, permissionFlags.SUPER_ADMIN)) {
        throw new UploadError(403, 'Forbidden');
      }
      if (!Number.isInteger(submissionId) || submissionId <= 0) {
        throw new UploadError(400, 'Invalid submissionId in meta');
      }
      const submission = await LevelSubmission.findByPk(submissionId);
      if (!submission) {
        throw new UploadError(404, 'Level submission not found');
      }
      if (submission.status !== 'pending') {
        throw new UploadError(409, 'Submission is not pending');
      }
      const job = await SubmissionJobService.getItemState('level', submissionId);
      if (shouldSkipEnqueue(job?.status) === 'inflight') {
        throw new UploadError(409, 'This submission is already being approved or declined. Wait for it to finish.');
      }
      return { meta: { levelId: null, forSubmission: false, submissionId } };
    }

    if (levelId == null) {
      // "New submission" path: require the submission gate. This matches the
      // checks run by `/v2/form/level/validate` so a replay of /init that
      // bypasses the form endpoint still goes through the same guardrails.
      if (!forSubmission) {
        throw new UploadError(400, 'Missing levelId (or set meta.forSubmission to true for new submissions)');
      }
      if (isPermissionBanActive(user, user.player?.bannedUntil)) {
        throw new UploadError(403, 'You are banned');
      }
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
    return { meta: { levelId, forSubmission: false, submissionId: null } };
  },

  async onAssembled({ assembledPath }) {
    return { assembledPath };
  },
};
