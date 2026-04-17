import type { Request } from 'express';
import type { Transaction } from 'sequelize';

import sequelize from '@/config/db.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { sseManager } from '@/misc/utils/server/sse.js';

import Level from '@/models/levels/Level.js';
import Difficulty from '@/models/levels/Difficulty.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Creator from '@/models/credits/Creator.js';
import {
  PassSubmission,
  PassSubmissionJudgements,
  PassSubmissionFlags,
} from '@/models/submissions/PassSubmission.js';
import Pass from '@/models/passes/Pass.js';
import Judgement from '@/models/passes/Judgement.js';
import { OAuthProvider, User } from '@/models/index.js';
import Player from '@/models/players/Player.js';

import { getScoreV2 } from '@/misc/utils/pass/CalcScore.js';
import { calcAcc } from '@/misc/utils/pass/CalcAcc.js';
import { passSubmissionHook } from '@/server/routes/v2/webhooks/webhook.js';

import { formError } from '../shared/errors.js';
import { parseAndSanitizePassForm, type PassFormSanitised } from './dto.js';

export interface CreatePassSubmissionInput {
  req: Request;
  userId: string;
  formPayload: Record<string, unknown>;
}

export interface CreatePassSubmissionResult {
  success: true;
  submissionId: number;
  message: string;
}

/**
 * Pure-JSON pass submission flow. The pass branch is much simpler than the
 * level branch — no uploads, no evidence, no multi-phase orchestration.
 */
export async function createPassSubmission(
  input: CreatePassSubmissionInput,
): Promise<CreatePassSubmissionResult> {
  const { userId, formPayload } = input;

  const sanitized = parseAndSanitizePassForm(formPayload);

  let transaction: Transaction | undefined;
  try {
    transaction = await sequelize.transaction();

    const level = await loadLevelOr404(sanitized.levelId, transaction);
    await assertNoDuplicatePassSubmission(sanitized, transaction);
    await assertNoDuplicatePass(sanitized, transaction);

    const { score, accuracy } = computeScoreAndAccuracy(sanitized, level);

    const submission = await PassSubmission.create(
      {
        levelId: sanitized.levelId,
        speed: sanitized.speed,
        scoreV2: score,
        accuracy,
        passer: sanitized.passer,
        passerId: sanitized.passerId,
        passerRequest: sanitized.passerRequest,
        feelingDifficulty: sanitized.feelingDifficulty,
        title: sanitized.title,
        videoLink: sanitized.videoLink,
        rawTime: sanitized.rawTime,
        status: 'pending',
        assignedPlayerId: !sanitized.passerRequest ? sanitized.passerId : null,
        userId,
      },
      { transaction },
    );

    await PassSubmissionJudgements.create(
      {
        ...sanitized.judgements,
        passSubmissionId: submission.id,
      },
      { transaction },
    );

    await PassSubmissionFlags.upsert(
      {
        passSubmissionId: submission.id,
        is12K: sanitized.is12K,
        isNoHoldTap: sanitized.isNoHoldTap,
        is16K: sanitized.is16K,
      },
      { transaction },
    );

    const passObj = await PassSubmission.findByPk(submission.id, {
      include: [
        { model: PassSubmissionJudgements, as: 'judgements' },
        { model: PassSubmissionFlags, as: 'flags' },
        {
          model: Level,
          as: 'level',
          include: [
            { model: Difficulty, as: 'difficulty' },
            {
              model: LevelCredit,
              as: 'levelCredits',
              include: [{ model: Creator, as: 'creator' }],
            },
          ],
        },
        {
          model: User,
          as: 'passSubmitter',
          attributes: ['id', 'username', 'playerId', 'avatarUrl'],
          include: [
            { model: Player, as: 'player' },
            {
              model: OAuthProvider,
              as: 'providers',
              required: false,
              where: { provider: 'discord' },
            },
          ],
        },
      ],
      transaction,
    });

    if (!passObj) throw formError.server('Failed to create pass submission');

    await transaction.commit();
    transaction = undefined;

    try {
      await passSubmissionHook(passObj, sanitized.judgements);
    } catch (hookError) {
      logger.warn('passSubmissionHook failed:', hookError);
    }

    sseManager.broadcast({
      type: 'submissionUpdate',
      data: { action: 'create', submissionId: submission.id, submissionType: 'pass' },
    });

    return {
      success: true,
      submissionId: submission.id,
      message: 'Pass submission saved successfully',
    };
  } catch (err) {
    if (transaction) await safeTransactionRollback(transaction);
    throw err;
  }
}

async function loadLevelOr404(levelId: number, transaction: Transaction): Promise<Level> {
  const level = await Level.findByPk(levelId, {
    include: [{ model: Difficulty, as: 'difficulty' }],
    transaction,
  });
  if (!level) throw formError.notFound('Level not found');
  if (!level.difficulty) throw formError.notFound('Difficulty not found');
  return level;
}

async function assertNoDuplicatePassSubmission(
  sanitized: PassFormSanitised,
  transaction: Transaction,
): Promise<void> {
  const existingSubmission = await PassSubmission.findOne({
    where: {
      status: 'pending',
      levelId: sanitized.levelId,
      speed: sanitized.speed,
      passer: sanitized.passer,
      passerRequest: sanitized.passerRequest,
      title: sanitized.title,
      videoLink: sanitized.videoLink,
      rawTime: sanitized.rawTime,
    },
    transaction,
  });
  if (!existingSubmission) return;

  const existingJudgements = await PassSubmissionJudgements.findOne({
    where: {
      passSubmissionId: existingSubmission.id,
      ...sanitized.judgements,
    },
    transaction,
  });
  const existingFlags = await PassSubmissionFlags.findOne({
    where: {
      passSubmissionId: existingSubmission.id,
      is12K: sanitized.is12K,
      isNoHoldTap: sanitized.isNoHoldTap,
      is16K: sanitized.is16K,
    },
    transaction,
  });
  if (existingJudgements && existingFlags) {
    throw formError.bad('Identical submission already exists', {
      details: {
        levelId: sanitized.levelId,
        speed: sanitized.speed,
        videoLink: sanitized.videoLink,
      },
    });
  }
}

async function assertNoDuplicatePass(
  sanitized: PassFormSanitised,
  transaction: Transaction,
): Promise<void> {
  const existingJudgement = await Judgement.findOne({
    where: { ...sanitized.judgements },
    transaction,
  });
  if (!existingJudgement) return;

  const existingPass = await Pass.findOne({
    where: {
      id: existingJudgement.id,
      levelId: sanitized.levelId,
      speed: sanitized.speed,
      videoLink: sanitized.videoLink,
      is12K: sanitized.is12K,
      isNoHoldTap: sanitized.isNoHoldTap,
      is16K: sanitized.is16K,
    },
    transaction,
  });
  if (existingPass) {
    throw formError.bad(
      'A pass with identical video, judgements, and flags already exists for this level and speed',
      {
        details: {
          levelId: sanitized.levelId,
          speed: sanitized.speed,
          videoLink: sanitized.videoLink,
          title: sanitized.title,
        },
      },
    );
  }
}

function computeScoreAndAccuracy(
  sanitized: PassFormSanitised,
  level: Level,
): { score: number; accuracy: number } {
  const levelData = {
    baseScore: level.baseScore,
    ppBaseScore: level.ppBaseScore,
    difficulty: level.difficulty,
  };

  const score = getScoreV2(
    {
      speed: sanitized.speed,
      judgements: sanitized.judgements,
      isNoHoldTap: sanitized.isNoHoldTap,
    },
    levelData,
  );
  if (!Number.isFinite(score)) {
    throw formError.bad('Invalid judgement values - could not calculate score', {
      details: { judgements: sanitized.judgements, speed: sanitized.speed, levelId: sanitized.levelId },
    });
  }

  const accuracy = calcAcc(sanitized.judgements);
  if (!Number.isFinite(accuracy)) {
    throw formError.bad('Invalid judgement values - could not calculate accuracy', {
      details: { judgements: sanitized.judgements },
    });
  }

  return { score, accuracy };
}
