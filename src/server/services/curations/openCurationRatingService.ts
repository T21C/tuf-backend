import {type Transaction} from 'sequelize';
import Level from '@/models/levels/Level.js';
import Curation from '@/models/curations/Curation.js';
import CurationRating from '@/models/curations/CurationRating.js';
import {mapMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {
  assignCurationFlow,
  parseCurationFlow,
  type CurationFlowId,
} from '@/misc/utils/data/curationFlow.js';
import {sanitizeTextInput} from '@/misc/utils/Utility.js';

export class CurationQueueError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'CurationQueueError';
  }
}

export async function ensureOpenCurationRating(
  levelId: number,
  transaction: Transaction,
): Promise<{rating: CurationRating; created: boolean}> {
  const level = await Level.findByPk(levelId, {transaction, lock: true});
  if (!level) {
    throw new Error(`Level ${levelId} not found`);
  }

  const existing = await CurationRating.findOne({
    where: {levelId, confirmedAt: null},
    transaction,
  });
  if (existing) {
    return {rating: existing, created: false};
  }

  try {
    const rating = await CurationRating.create(
      {
        levelId,
        confirmedAt: null,
        settledByUserId: null,
      },
      {transaction},
    );
    return {rating, created: true};
  } catch (error) {
    if (mapMysqlClientError(error)?.code !== 'ER_DUP_ENTRY') {
      throw error;
    }
    const raced = await CurationRating.findOne({
      where: {levelId, confirmedAt: null},
      transaction,
    });
    if (!raced) {
      throw error;
    }
    return {rating: raced, created: false};
  }
}

export async function confirmOpenCurationRating(
  levelId: number,
  transaction: Transaction,
  settledByUserId: string | null = null,
): Promise<number | null> {
  const existing = await CurationRating.findOne({
    where: {levelId, confirmedAt: null},
    transaction,
  });
  if (!existing) return null;
  await existing.update(
    {
      confirmedAt: new Date(),
      settledByUserId,
    },
    {transaction},
  );
  return Number(existing.id);
}

export async function levelHasPublishedCuration(
  levelId: number,
  transaction?: Transaction,
): Promise<boolean> {
  const row = await Curation.findOne({
    where: {levelId},
    attributes: ['id'],
    transaction,
  });
  return Boolean(row);
}

export async function resolveCurationFlowForOpen(input: {
  levelId: number;
  bulk?: boolean;
  explicit?: unknown;
  transaction?: Transaction;
}): Promise<CurationFlowId> {
  const explicit = parseCurationFlow(input.explicit);
  const hasPublishedCuration = await levelHasPublishedCuration(input.levelId, input.transaction);
  return assignCurationFlow({
    bulk: input.bulk === true,
    hasPublishedCuration,
    explicit,
  });
}

export async function openLevelOnCurationPage(
  levelId: number,
  options: {
    flow: CurationFlowId;
    reason?: string | null;
    transaction: Transaction;
  },
): Promise<{rating: CurationRating; created: boolean}> {
  const level = await Level.findByPk(levelId, {
    attributes: ['id', 'toCuration', 'isDeleted', 'isHidden'],
    transaction: options.transaction,
    lock: true,
  });
  if (!level) {
    throw new CurationQueueError(404, 'missing_level', 'Level not found');
  }
  if (level.isDeleted) {
    throw new CurationQueueError(400, 'deleted', 'Deleted levels cannot be curated');
  }
  if (level.isHidden) {
    throw new CurationQueueError(400, 'hidden', 'Hidden levels cannot be curated');
  }
  if (level.toCuration) {
    throw new CurationQueueError(409, 'unsettled', 'This level is still on the curation page');
  }
  const opened = await ensureOpenCurationRating(levelId, options.transaction);
  await level.update({
    toCuration: true,
    curationFlow: options.flow,
    ...(options.reason !== undefined
      ? {curationRerateReason: sanitizeTextInput(options.reason)}
      : {}),
  }, {transaction: options.transaction});
  return opened;
}
