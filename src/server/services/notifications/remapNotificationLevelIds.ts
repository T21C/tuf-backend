import {QueryTypes, Transaction} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import Notification from '@/models/notifications/Notification.js';
import {exchangeNotificationLevelRef} from './exchangeNotificationLevelRef.js';

const notificationsSequelize = getSequelizeForModelGroup('notifications');

type NotificationLevelRow = {
  id: number | string;
  payload: unknown;
  entityType: string | null;
  entityId: string | null;
};

function parsePayload(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
}

async function swapChartClearMuteLevelIds(
  levelIdA: number,
  levelIdB: number,
  transaction: Transaction,
): Promise<void> {
  const negA = -levelIdA;
  const negB = -levelIdB;
  await notificationsSequelize.query('SET FOREIGN_KEY_CHECKS = 0', {transaction});
  try {
    await notificationsSequelize.query(
      `
      UPDATE chart_clear_notification_mutes
      SET levelId = CASE
        WHEN levelId = :a THEN :negA
        WHEN levelId = :b THEN :negB
        ELSE levelId
      END
      WHERE levelId IN (:a, :b)
      `,
      {replacements: {a: levelIdA, b: levelIdB, negA, negB}, transaction},
    );
    await notificationsSequelize.query(
      `
      UPDATE chart_clear_notification_mutes
      SET levelId = CASE
        WHEN levelId = :negA THEN :b
        WHEN levelId = :negB THEN :a
        ELSE levelId
      END
      WHERE levelId IN (:negA, :negB)
      `,
      {replacements: {a: levelIdA, b: levelIdB, negA, negB}, transaction},
    );
  } finally {
    await notificationsSequelize.query('SET FOREIGN_KEY_CHECKS = 1', {transaction});
  }
}

/**
 * After a level payload swap, notification links and clear mutes follow the chart
 * onto its new id. Runs on the notifications database, separate from the levels transaction.
 */
export async function remapNotificationsAfterLevelPayloadSwap(
  levelIdA: number,
  levelIdB: number,
): Promise<number> {
  if (
    !Number.isInteger(levelIdA) ||
    levelIdA <= 0 ||
    !Number.isInteger(levelIdB) ||
    levelIdB <= 0 ||
    levelIdA === levelIdB
  ) {
    return 0;
  }

  const transaction = await notificationsSequelize.transaction();
  try {
    const rows = await notificationsSequelize.query<NotificationLevelRow>(
      `
      SELECT id, payload, entityType, entityId
      FROM notifications
      WHERE CAST(JSON_UNQUOTE(JSON_EXTRACT(\`payload\`, '$.levelId')) AS UNSIGNED) IN (:a, :b)
         OR CAST(JSON_UNQUOTE(JSON_EXTRACT(\`payload\`, '$.swappedWithLevelId')) AS UNSIGNED) IN (:a, :b)
         OR (\`entityType\` = 'level' AND \`entityId\` IN (:aStr, :bStr))
      `,
      {
        replacements: {
          a: levelIdA,
          b: levelIdB,
          aStr: String(levelIdA),
          bStr: String(levelIdB),
        },
        type: QueryTypes.SELECT,
        transaction,
      },
    );

    let updated = 0;
    for (const row of rows) {
      const next = exchangeNotificationLevelRef(
        {
          payload: parsePayload(row.payload),
          entityType: row.entityType,
          entityId: row.entityId,
        },
        levelIdA,
        levelIdB,
      );
      if (!next.changed) continue;
      await Notification.update(
        {payload: next.payload as object, entityId: next.entityId},
        {where: {id: row.id}, transaction},
      );
      updated += 1;
    }

    await swapChartClearMuteLevelIds(levelIdA, levelIdB, transaction);
    await transaction.commit();
    return updated;
  } catch (error) {
    try {
      await transaction.rollback();
    } catch {
      // already finished
    }
    throw error;
  }
}
