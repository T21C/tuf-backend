'use strict';

const CDC_CHECKPOINT_REDIS_KEY = 'cdc:binlog_checkpoint';
const CDC_INGEST_PAUSED_KEY = 'cdc:ingest_paused';
const CDC_STREAM_PREFIX = 'cdc:';

/**
 * Pauses CDC ingest, runs a bulk migration body, advances the binlog checkpoint to the
 * current master position, and clears the passes CDC stream so projectors do not replay
 * row-level updates from mass UPDATE/backfill statements.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @param {() => Promise<void>} runBody
 */
async function runMigrationWithCdcBulkShield(sequelize, runBody) {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  let client;
  let shieldActive = false;

  try {
    const { createClient } = require('redis');
    client = createClient({ url: redisUrl });
    client.on('error', () => {});
    await client.connect();

    await client.set(CDC_INGEST_PAUSED_KEY, '1');
    await client.del(`${CDC_STREAM_PREFIX}passes`, `${CDC_STREAM_PREFIX}passes:dlq`);
    console.log('[migration-cdc] CDC ingest paused; passes stream cleared');
    shieldActive = true;

    await runBody();

    const [rows] = await sequelize.query('SHOW MASTER STATUS');
    const row = rows && rows[0];
    if (row && row.File != null && row.Position != null) {
      const checkpoint = {
        filename: String(row.File),
        position: Number(row.Position),
      };
      await client.set(CDC_CHECKPOINT_REDIS_KEY, JSON.stringify(checkpoint));
      console.log(
        `[migration-cdc] Binlog checkpoint advanced to ${checkpoint.filename}:${checkpoint.position}`,
      );
    } else {
      console.warn('[migration-cdc] SHOW MASTER STATUS returned no row; checkpoint not updated');
    }

    await client.del(`${CDC_STREAM_PREFIX}passes`, `${CDC_STREAM_PREFIX}passes:dlq`);
    console.log('[migration-cdc] Passes CDC stream cleared after bulk migration');
  } catch (err) {
    if (!shieldActive) {
      console.warn('[migration-cdc] CDC coordination unavailable; running migration without shield:', err?.message || err);
      await runBody();
    } else {
      throw err;
    }
  } finally {
    if (client) {
      try {
        await client.del(CDC_INGEST_PAUSED_KEY);
        await client.quit();
        console.log('[migration-cdc] CDC ingest resumed');
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = { runMigrationWithCdcBulkShield };
