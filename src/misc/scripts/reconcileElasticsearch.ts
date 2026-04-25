/**
 * Compares MySQL row counts with Elasticsearch document counts for core indices.
 * Exit code 1 if any drift is detected (for CI / cron smoke checks).
 */
import dotenv from 'dotenv';
dotenv.config();

import { reconcileElasticsearchCounts } from '@/server/services/elasticsearch/reconcileElasticsearchCounts.js';

async function main(): Promise<void> {
  const { rows, drift, ok } = await reconcileElasticsearchCounts();

  console.log(JSON.stringify({ reconciledAt: new Date().toISOString(), rows }, null, 2));

  if (!ok) {
    console.error('Drift detected:', drift);
    process.exit(1);
  }
  console.log('No count drift.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
