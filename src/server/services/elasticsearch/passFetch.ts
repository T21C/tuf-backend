import Pass from '@/models/passes/Pass.js';
import sequelize from '@/config/db.js';
import { safeTransactionRollback } from '@/misc/utils/Utility.js';
import { PASS_INCLUDES } from '@/server/services/elasticsearch/sequelizeIncludes.js';

export async function fetchPassWithRelations(passId: number): Promise<Pass | null> {
  let transaction: any;
  try {
    transaction = await sequelize.transaction();
    const pass = await Pass.findByPk(passId, {
      include: PASS_INCLUDES,
    });
    await transaction.commit();
    return pass;
  } catch (error) {
    await safeTransactionRollback(transaction);
    throw error;
  }
}
