'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));
      if (!names.includes('push_subscriptions')) {
        await transaction.commit();
        return;
      }

      const description = await queryInterface.describeTable('push_subscriptions');
      if (!description.deviceKey) {
        await queryInterface.addColumn(
          'push_subscriptions',
          'deviceKey',
          {
            type: Sequelize.STRING(64),
            allowNull: true,
          },
          {transaction},
        );
      }
      if (!description.revokedAt) {
        await queryInterface.addColumn(
          'push_subscriptions',
          'revokedAt',
          {
            type: Sequelize.DATE,
            allowNull: true,
          },
          {transaction},
        );
      }

      const indexes = await queryInterface.showIndex('push_subscriptions', {transaction});
      const hasDeviceIndex = indexes.some((index) => {
        const name = index.name || index.Key_name;
        return name === 'push_subscriptions_user_device';
      });
      if (!hasDeviceIndex) {
        await queryInterface.addIndex('push_subscriptions', ['userId', 'deviceKey'], {
          name: 'push_subscriptions_user_device',
          unique: true,
          transaction,
        });
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
      if (!names.includes('push_subscriptions')) {
        await transaction.commit();
        return;
      }

      const indexes = await queryInterface.showIndex('push_subscriptions', {transaction});
      const hasDeviceIndex = indexes.some((index) => {
        const name = index.name || index.Key_name;
        return name === 'push_subscriptions_user_device';
      });
      if (hasDeviceIndex) {
        await queryInterface.removeIndex('push_subscriptions', 'push_subscriptions_user_device', {
          transaction,
        });
      }

      const description = await queryInterface.describeTable('push_subscriptions');
      if (description.revokedAt) {
        await queryInterface.removeColumn('push_subscriptions', 'revokedAt', {transaction});
      }
      if (description.deviceKey) {
        await queryInterface.removeColumn('push_subscriptions', 'deviceKey', {transaction});
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
