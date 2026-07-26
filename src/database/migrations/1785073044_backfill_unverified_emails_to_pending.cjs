'use strict';

/**
 * Backfill: unverified users.email → pendingEmail (email cleared).
 * EMAIL_VERIFIED flag is permissionFlags bit 0 (1 << 0).
 * Also clears legacy plaintext passwordResetToken after cutover.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const users = await queryInterface.describeTable('users');
      if (!users.pendingEmail) {
        throw new Error(
          'pendingEmail column missing — run 1785073043_add_email_credential_security_schema first',
        );
      }

      // Move unverified emails to pendingEmail
      await queryInterface.sequelize.query(
        `
        UPDATE users
        SET
          pendingEmail = email,
          email = NULL,
          passwordResetToken = NULL,
          emailVerifyTokenHash = NULL,
          emailVerifyExpires = NULL
        WHERE
          email IS NOT NULL
          AND email != ''
          AND (permissionFlags & 1) = 0
          AND (pendingEmail IS NULL OR pendingEmail = '')
        `,
        { transaction },
      );

      // Clear leftover plaintext reset tokens on verified rows
      if (users.passwordResetToken) {
        await queryInterface.sequelize.query(
          `
          UPDATE users
          SET passwordResetToken = NULL
          WHERE passwordResetToken IS NOT NULL AND passwordResetToken != ''
          `,
          { transaction },
        );
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Best-effort reverse: pending-only unverified rows → email
      await queryInterface.sequelize.query(
        `
        UPDATE users
        SET
          email = pendingEmail,
          pendingEmail = NULL
        WHERE
          email IS NULL
          AND pendingEmail IS NOT NULL
          AND pendingEmail != ''
          AND (permissionFlags & 1) = 0
        `,
        { transaction },
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
