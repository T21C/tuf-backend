'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const desc = await queryInterface.describeTable('oauth_clients');
      if (!desc.iconUrl) {
        await queryInterface.addColumn(
          'oauth_clients',
          'iconUrl',
          {
            type: Sequelize.STRING(512),
            allowNull: true,
            defaultValue: null,
          },
          { transaction },
        );
      }
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const desc = await queryInterface.describeTable('oauth_clients');
      if (desc.iconUrl) {
        await queryInterface.removeColumn('oauth_clients', 'iconUrl', { transaction });
      }
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },
};
