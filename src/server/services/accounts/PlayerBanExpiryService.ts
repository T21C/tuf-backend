import {CronJob} from 'cron';
import {Op} from 'sequelize';
import Player from '@/models/players/Player.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {setPlayerBanStatus, setRerateRequestBanStatus} from '@/server/services/accounts/PlayerBanService.js';
import User from '@/models/auth/User.js';
import {hasFlag} from '@/misc/utils/auth/permissionUtils.js';
import {permissionFlags} from '@/config/constants.js';

const CRON_SCHEDULE = '* * * * *';
const BATCH_SIZE = 200;

export class PlayerBanExpiryService {
  private static instance: PlayerBanExpiryService;
  private cronJob: CronJob | null = null;

  private constructor() {
    this.cronJob = new CronJob(CRON_SCHEDULE, () => {
      void this.runDueUnbans();
    });
    this.cronJob.start();
    logger.info('[PlayerBanExpiry] Scheduled job started (every minute)');
  }

  public static getInstance(): PlayerBanExpiryService {
    if (!PlayerBanExpiryService.instance) {
      PlayerBanExpiryService.instance = new PlayerBanExpiryService();
    }
    return PlayerBanExpiryService.instance;
  }

  public async runDueUnbans(): Promise<{processed: number; unbanned: number}> {
    try {
      const duePlayers = await Player.findAll({
        where: {
          isBanned: true,
          bannedUntil: {[Op.not]: null, [Op.lte]: new Date()},
        },
        attributes: ['id'],
        limit: BATCH_SIZE,
      });

      let unbanned = 0;
      for (const row of duePlayers) {
        try {
          await setPlayerBanStatus(row.id, {isBanned: false});
          unbanned += 1;
        } catch (err) {
          logger.error('[PlayerBanExpiry] Failed to expire player ban', {
            playerId: row.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (duePlayers.length > 0) {
        logger.debug('[PlayerBanExpiry] Batch processed', {
          processed: duePlayers.length,
          unbanned,
        });
      }

      const dueRerate = await Player.findAll({
        where: {
          rerateRequestBannedUntil: {[Op.not]: null, [Op.lte]: new Date()},
        },
        attributes: ['id', 'rerateRequestBannedUntil'],
        include: [{model: User, as: 'user', attributes: ['id', 'permissionFlags'], required: false}],
        limit: BATCH_SIZE,
      });
      for (const row of dueRerate) {
        if (row.user && !hasFlag(row.user, permissionFlags.RERATE_REQUEST_BANNED)) {
          await row.update({rerateRequestBannedUntil: null});
          continue;
        }
        try {
          await setRerateRequestBanStatus(row.id, {banned: false});
          unbanned += 1;
        } catch (err) {
          logger.error('[PlayerBanExpiry] Failed to expire rerate request ban', {
            playerId: row.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return {processed: duePlayers.length + dueRerate.length, unbanned};
    } catch (err) {
      logger.error('[PlayerBanExpiry] Batch lookup failed', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return {processed: 0, unbanned: 0};
    }
  }
}
