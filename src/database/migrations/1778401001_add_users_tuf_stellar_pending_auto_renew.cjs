'use strict';

/** Per-profile TUFStellar icon art choice (`1` | `2` | `3`) for player and creator rows. */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'users',
        'tufStellarPendingAutoRenew',
        {
          type: Sequelize.BOOLEAN,
          allowNull: true,
          defaultValue: null,
        },
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeColumn('users', 'tufStellarPendingAutoRenew', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
