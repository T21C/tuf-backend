import { CronJob } from 'cron';
import { logger } from '@/server/services/core/LoggerService.js';
import { reconcileElasticsearchCounts } from '@/server/services/elasticsearch/reconcileElasticsearchCounts.js';

/** Daily ~05:15 UTC — count smoke check vs ES (see npm run reconcile:es). */
const CRON_SCHEDULE = '15 5 * * *';

export class ElasticsearchReconcileCronService {
  private static cron: CronJob | null = null;

  static startScheduledReconciliation(): void {
    if (process.env.ES_RECONCILE_CRON_DISABLED === '1') {
      logger.info('Elasticsearch reconcile cron disabled (ES_RECONCILE_CRON_DISABLED=1)');
      return;
    }
    if (ElasticsearchReconcileCronService.cron) return;

    ElasticsearchReconcileCronService.cron = new CronJob(CRON_SCHEDULE, async () => {
      try {
        const { ok, drift, rows } = await reconcileElasticsearchCounts();
        if (!ok) {
          logger.error('Elasticsearch count drift (scheduled reconcile)', { drift, rows });
        } else {
          logger.info('Elasticsearch scheduled reconcile: no count drift', { rows });
        }
      } catch (error) {
        logger.error('Elasticsearch scheduled reconcile failed', error);
      }
    });

    ElasticsearchReconcileCronService.cron.start();
    logger.info('Elasticsearch reconcile cron started');
  }
}
