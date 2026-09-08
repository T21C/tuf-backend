'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));
      if (!names.includes('notification_user_settings')) {
        await transaction.commit();
        return;
      }

      const description = await queryInterface.describeTable('notification_user_settings');
      if (!description.hideOwnActivity) {
        await queryInterface.addColumn(
          'notification_user_settings',
          'hideOwnActivity',
          {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          {transaction},
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
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));
      if (!names.includes('notification_user_settings')) {
        await transaction.commit();
        return;
      }

      const description = await queryInterface.describeTable('notification_user_settings');
      if (description.hideOwnActivity) {
        await queryInterface.removeColumn('notification_user_settings', 'hideOwnActivity', {
          transaction,
        });
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
