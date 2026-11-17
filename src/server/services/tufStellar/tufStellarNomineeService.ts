import {Op, type Transaction} from 'sequelize';
import sequelize from '@/config/db.js';
import RatingDetail from '@/models/levels/RatingDetail.js';
import CurationRatingDetail from '@/models/curations/CurationRatingDetail.js';
import TufStellarNomineeMonth from '@/models/billing/TufStellarNomineeMonth.js';
import {OutboxService} from '@/server/services/outbox/OutboxService.js';
import {
  OUTBOX_EVENT_TYPES,
  type TufStellarNomineeKind,
} from '@/server/services/outbox/events.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {mapMysqlClientError} from '@/misc/utils/db/mysqlClientError.js';
import {safeTransactionRollback} from '@/misc/utils/Utility.js';
import {
  MONTHLY_NOMINEE_THRESHOLD,
  shouldEnqueueMonthlyNominee,
  utcMonthBounds,
  utcMonthKey,
} from '@/server/services/tufStellar/tufStellarNominee.js';

const AUTORATER_USERNAME = 'autorater';

export function isAutoraterAccount(user: {id: string; username: string}): boolean {
  const botId = (process.env.AUTORATER_UUID || '').trim();
  if (botId && user.id === botId) return true;
  return user.username === AUTORATER_USERNAME;
}

function createdInUtcMonth(now: Date) {
  const {start, next} = utcMonthBounds(now);
  return {
    [Op.gte]: start,
    [Op.lt]: next,
  };
}

export async function countOfficialVotesInUtcMonth(
  kind: TufStellarNomineeKind,
  userId: string,
  now: Date,
  transaction?: Transaction,
): Promise<number> {
  const createdAt = createdInUtcMonth(now);
  if (kind === 'curation') {
    return CurationRatingDetail.count({
      where: {userId, createdAt},
      transaction,
    });
  }
  return RatingDetail.count({
    where: {
      userId,
      isCommunityRating: false,
      createdAt,
    },
    transaction,
  });
}

export async function enqueueTufStellarNomineeIfEligible(args: {
  kind: TufStellarNomineeKind;
  user: {
    id: string;
    username: string;
    avatarUrl?: string | null;
    playerId?: number | null;
  };
  isNewOfficialVote: boolean;
  priorOfficialCountThisMonth: number;
  now?: Date;
}): Promise<void> {
  const isAutorater = isAutoraterAccount(args.user);
  if (
    !shouldEnqueueMonthlyNominee({
      isNewOfficialVote: args.isNewOfficialVote,
      isAutorater,
      priorOfficialCountThisMonth: args.priorOfficialCountThisMonth,
    })
  ) {
    return;
  }

  const now = args.now ?? new Date();
  const monthKey = utcMonthKey(now);
  const transaction = await sequelize.transaction();
  try {
    await TufStellarNomineeMonth.create(
      {
        userId: args.user.id,
        monthKey,
        kind: args.kind,
      },
      {transaction},
    );
    await OutboxService.emit(OUTBOX_EVENT_TYPES.DiscordTufStellarNominee, {
      aggregate: 'user',
      aggregateId: args.user.id,
      payload: {
        userId: args.user.id,
        username: args.user.username,
        avatarUrl: args.user.avatarUrl ?? null,
        playerId: args.user.playerId ?? null,
        monthKey,
        kind: args.kind,
        officialCountThisMonth: MONTHLY_NOMINEE_THRESHOLD,
      },
      dedupKey: `tufstellar-nominee:${args.kind}:${args.user.id}:${monthKey}`,
      transaction,
    });
    await transaction.commit();
  } catch (err) {
    await safeTransactionRollback(transaction);
    if (mapMysqlClientError(err)?.code === 'ER_DUP_ENTRY') {
      logger.debug('[tufstellar-nominee] Already nominated this month', {
        kind: args.kind,
        userId: args.user.id,
        monthKey,
      });
      return;
    }
    throw err;
  }
}
