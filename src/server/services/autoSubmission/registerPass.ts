import { createHash } from 'node:crypto';
import sequelize from '@/config/db.js';
import AutoSubmissionReceipt from '@/models/submissions/AutoSubmissionReceipt.js';
import User from '@/models/auth/User.js';
import Player from '@/models/players/Player.js';
import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import Pass from '@/models/passes/Pass.js';
import Judgement from '@/models/passes/Judgement.js';
import { deriveKeyFlags } from '@/misc/utils/pass/keyCount.js';
import { gateSubmissionUser } from '@/server/services/submissions/submissionPermission.js';
import { formError } from '@/server/services/submissions/submissionErrors.js';
import { updateWorldsFirstFlags } from '@/server/services/passes/worldsFirst.js';
import { eligibleDifficulty, type RegistrationInput } from './registrationSchema.js';
import { requireSubmissionAuthorization } from './authorization.js';
import { prepareAutoSubmissionResult } from './resultPreparation.js';

/** A pass and its idempotency receipt commit together, including on HTTP response loss. */
export async function registerAutoSubmission(input: RegistrationInput): Promise<number> {
  const requestHash = createHash('sha256').update(JSON.stringify({
    run_id: input.run_id,
    owner_id: input.owner_id,
    level_id: input.level_id,
    validation: input.validation,
  })).digest('hex');
  return sequelize.transaction(async transaction => {
    const user = await User.findByPk(input.owner_id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
      include: [{ model: Player, as: 'player' }],
    });
    const existing = await AutoSubmissionReceipt.findByPk(input.run_id, { transaction });
    if (existing) {
      if (existing.ownerId !== input.owner_id || existing.requestHash !== requestHash) {
        throw formError.conflict('Run was already registered with different evidence');
      }
      return existing.passId;
    }
    await requireSubmissionAuthorization(input.owner_id, input.grant_id, transaction);
    if (!user || user.status !== 'active' || user.deletionScheduledAt) {
      throw formError.forbid('Account cannot submit');
    }
    gateSubmissionUser(user);
    if (!user.playerId || !user.player) throw formError.forbid('A linked player is required');
    const level = await Level.findByPk(input.level_id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
      include: [{ model: Difficulty, as: 'difficulty' }],
    });
    if (!level || level.isDeleted || level.isHidden || !level.difficulty
        || !eligibleDifficulty(level.difficulty.type, level.difficulty.name)) {
      throw formError.forbid('Only visible P and G charts support auto submission');
    }
    if (level.fileId !== input.current_file_id) throw formError.conflict('level_revision_changed');
    const result = prepareAutoSubmissionResult(input.validation, level);
    const keyFlags = deriveKeyFlags(input.validation.key_count);
    const pass = await Pass.create({
      levelId: level.id,
      playerId: user.playerId,
      speed: input.validation.speed,
      vidTitle: '',
      videoLink: null,
      vidUploadTime: new Date(),
      keyCount: input.validation.key_count,
      ...keyFlags,
      isNoHoldTap: input.validation.is_no_hold_tap,
      isAdofaiV2: result.isAdofaiV2,
      adofaiVersion: result.adofaiVersion,
      isXPerfectMode: result.isXPerfectMode,
      passMetaFlags: result.passMetaFlags,
      submissionSource: 'auto_submission',
      autoSubmissionRunId: input.run_id,
      feelingRating: null,
      expectedRating: null,
      accuracy: result.accuracy,
      scoreV2: result.scoreV2,
      isAnnounced: false,
      isDeleted: false,
    }, { transaction });
    const now = new Date();
    await Judgement.create({
      id: pass.id,
      ...result.judgements,
      createdAt: now,
      updatedAt: now,
    }, { transaction });
    await updateWorldsFirstFlags(level.id, transaction);
    await AutoSubmissionReceipt.create({
      runId: input.run_id,
      ownerId: input.owner_id,
      passId: pass.id,
      requestHash,
      validation: input.validation,
    }, { transaction });
    return pass.id;
  });
}
