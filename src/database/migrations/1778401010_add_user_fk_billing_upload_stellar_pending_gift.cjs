'use strict';

/**
 * Enforce referential integrity for nullable user UUID pointers:
 * - billing_events.user_id / beneficiary_user_id → users.id (ON DELETE SET NULL)
 * - upload_sessions.userId → users.id (ON DELETE SET NULL)
 * - user_tuf_stellar_billing.tufStellarPendingGiftBeneficiaryUserId → users.id (ON DELETE SET NULL)
 *
 * Pre-production: clears all pointer values, then ALTERs child columns to match `users.id`
 * exactly (charset + collation + type). That avoids InnoDB "incompatible" FK errors that
 * occur when Sequelize emits CHAR(36) with a different collation than `users.id`.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const t = await qi.sequelize.transaction();
    try {
      await qi.sequelize.query(
        `UPDATE billing_events SET user_id = NULL, beneficiary_user_id = NULL`,
        { transaction: t },
      );
      await qi.sequelize.query(
        `UPDATE user_tuf_stellar_billing SET tufStellarPendingGiftBeneficiaryUserId = NULL, tufStellarPendingGiftMonths = NULL`,
        { transaction: t },
      );
      await qi.sequelize.query(`UPDATE upload_sessions SET userId = NULL`, { transaction: t });

      const [idRows] = await qi.sequelize.query(
        `SELECT COLUMN_TYPE, CHARACTER_SET_NAME, COLLATION_NAME
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'id'`,
        { transaction: t },
      );
      const idCol = idRows[0];
      if (!idCol) {
        throw new Error('[1778401010] users.id not found in information_schema.COLUMNS');
      }
      let usersIdMysqlType = String(idCol.COLUMN_TYPE || '').trim();
      if (idCol.CHARACTER_SET_NAME) {
        usersIdMysqlType += ` CHARACTER SET ${idCol.CHARACTER_SET_NAME}`;
        if (idCol.COLLATION_NAME) {
          usersIdMysqlType += ` COLLATE ${idCol.COLLATION_NAME}`;
        }
      }

      await qi.sequelize.query(
        `ALTER TABLE billing_events
           MODIFY COLUMN user_id ${usersIdMysqlType} NULL,
           MODIFY COLUMN beneficiary_user_id ${usersIdMysqlType} NULL`,
        { transaction: t },
      );
      await qi.sequelize.query(
        `ALTER TABLE user_tuf_stellar_billing
           MODIFY COLUMN tufStellarPendingGiftBeneficiaryUserId ${usersIdMysqlType} NULL`,
        { transaction: t },
      );
      await qi.sequelize.query(
        `ALTER TABLE upload_sessions MODIFY COLUMN userId ${usersIdMysqlType} NULL`,
        { transaction: t },
      );

      const [userIdIndexRows] = await qi.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'upload_sessions'
           AND INDEX_NAME = 'idx_upload_sessions_user_id'`,
        { transaction: t },
      );
      if (Number(userIdIndexRows[0]?.cnt ?? 0) === 0) {
        await qi.addIndex('upload_sessions', ['userId'], {
          name: 'idx_upload_sessions_user_id',
          transaction: t,
        });
      }

      const fkBillingUser = 'billing_events_user_id_users_fk';
      const fkBillingBen = 'billing_events_beneficiary_user_id_users_fk';
      const fkUploadUser = 'upload_sessions_user_id_users_fk';
      const fkPendingGift = 'user_tuf_stellar_billing_pending_gift_beneficiary_users_fk';

      const [fk1Rows] = await qi.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'billing_events' AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND CONSTRAINT_NAME = :n`,
        { replacements: { n: fkBillingUser }, transaction: t },
      );
      if (Number(fk1Rows[0]?.cnt ?? 0) === 0) {
        await qi.addConstraint('billing_events', {
          fields: ['user_id'],
          type: 'foreign key',
          name: fkBillingUser,
          references: { table: 'users', field: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
          transaction: t,
        });
      }

      const [fk2Rows] = await qi.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'billing_events' AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND CONSTRAINT_NAME = :n`,
        { replacements: { n: fkBillingBen }, transaction: t },
      );
      if (Number(fk2Rows[0]?.cnt ?? 0) === 0) {
        await qi.addConstraint('billing_events', {
          fields: ['beneficiary_user_id'],
          type: 'foreign key',
          name: fkBillingBen,
          references: { table: 'users', field: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
          transaction: t,
        });
      }

      const [fk3Rows] = await qi.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'upload_sessions' AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND CONSTRAINT_NAME = :n`,
        { replacements: { n: fkUploadUser }, transaction: t },
      );
      if (Number(fk3Rows[0]?.cnt ?? 0) === 0) {
        await qi.addConstraint('upload_sessions', {
          fields: ['userId'],
          type: 'foreign key',
          name: fkUploadUser,
          references: { table: 'users', field: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
          transaction: t,
        });
      }

      const [fk4Rows] = await qi.sequelize.query(
        `SELECT COUNT(*) AS cnt FROM information_schema.TABLE_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'user_tuf_stellar_billing' AND CONSTRAINT_TYPE = 'FOREIGN KEY' AND CONSTRAINT_NAME = :n`,
        { replacements: { n: fkPendingGift }, transaction: t },
      );
      if (Number(fk4Rows[0]?.cnt ?? 0) === 0) {
        await qi.addConstraint('user_tuf_stellar_billing', {
          fields: ['tufStellarPendingGiftBeneficiaryUserId'],
          type: 'foreign key',
          name: fkPendingGift,
          references: { table: 'users', field: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
          transaction: t,
        });
      }

      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
  },

  async down(queryInterface, Sequelize) {
    const qi = queryInterface;
    const t = await qi.sequelize.transaction();
    const dropFk = async (table, name) => {
      try {
        await qi.removeConstraint(table, name, { transaction: t });
      } catch {
        /* constraint may not exist */
      }
    };
    try {
      await dropFk('user_tuf_stellar_billing', 'user_tuf_stellar_billing_pending_gift_beneficiary_users_fk');
      await dropFk('upload_sessions', 'upload_sessions_user_id_users_fk');
      await dropFk('billing_events', 'billing_events_beneficiary_user_id_users_fk');
      await dropFk('billing_events', 'billing_events_user_id_users_fk');

      try {
        await qi.removeIndex('upload_sessions', 'idx_upload_sessions_user_id', { transaction: t });
      } catch {
        /* index may not exist */
      }

      await qi.changeColumn(
        'billing_events',
        'user_id',
        {
          type: Sequelize.STRING(64),
          allowNull: true,
        },
        { transaction: t },
      );
      await qi.changeColumn(
        'billing_events',
        'beneficiary_user_id',
        {
          type: Sequelize.STRING(36),
          allowNull: true,
        },
        { transaction: t },
      );
      await qi.changeColumn(
        'user_tuf_stellar_billing',
        'tufStellarPendingGiftBeneficiaryUserId',
        {
          type: Sequelize.STRING(36),
          allowNull: true,
        },
        { transaction: t },
      );

      await qi.changeColumn(
        'upload_sessions',
        'userId',
        {
          type: Sequelize.UUID,
          allowNull: true,
          defaultValue: null,
        },
        { transaction: t },
      );

      await t.commit();
    } catch (e) {
      await t.rollback();
      throw e;
    }
  },
};
