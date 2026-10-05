/** Non-destructive schema setup for the freshly created local development DB. */
import dotenv from 'dotenv';
import type {SyncOptions} from 'sequelize';
dotenv.config();

async function main() {
  if (process.env.NODE_ENV !== 'development' || process.env.DB_HOST !== '127.0.0.1'
    || process.env.DB_DATABASE !== 'tuf_web_test') throw new Error('Local test DB required');
  const {db} = await import('@/models/index.js');
  await import('@/models/outbox/OutboxEvent.js');
  const {getPoolManagerInstance} = await import('@/config/db.js');
  const pools = getPoolManagerInstance().getAllPools();
  const [rows] = await db.sequelize.query('SHOW TABLES');
  if (rows.length > 0 && !process.argv.includes('--resume')) {
    throw new Error('Use --resume only for the partially initialized local test database');
  }
  for (const [name, pool] of pools) {
    if (!Object.keys(pool.models).length) continue;
    // Some legacy models describe full TEXT indexes that MySQL cannot create.
    // Local fixture schemas use an index prefix; production migrations remain unchanged.
    for (const model of Object.values(pool.models)) {
      for (const index of model.options.indexes ?? []) {
        index.fields = index.fields?.map((field) => {
          if (typeof field !== 'string' && !('name' in field)) return field;
          const name = typeof field === 'string' ? field : field.name;
          const attribute = Object.values(model.rawAttributes).find((entry) => entry.field === name);
          if ((attribute?.type as {key?: string})?.key === 'TEXT') {
            return typeof field === 'string' ? {name: field, length: 191} : {...field, length: 191};
          }
          return field;
        });
      }
    }
    const transaction = await pool.transaction();
    try {
      await pool.query('SET FOREIGN_KEY_CHECKS=0', {transaction});
      const syncOptions = {transaction} as SyncOptions & {transaction: typeof transaction};
      await pool.sync(syncOptions);
      await pool.query('SET FOREIGN_KEY_CHECKS=1', {transaction});
      await transaction.commit();
      console.log('Created local schema for model pool:', name);
    } catch (error) {
      await pool.query('SET FOREIGN_KEY_CHECKS=1', {transaction});
      await transaction.rollback();
      throw error;
    }
  }
  console.log('Local database schema ready');
  process.exit(0);
}
main().catch((error) => {
  console.error('Local schema setup failed:', (error as Error).message);
  process.exit(1);
});
