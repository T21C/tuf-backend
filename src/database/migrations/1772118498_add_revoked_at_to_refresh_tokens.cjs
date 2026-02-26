'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('refresh_tokens');
    if (!tableInfo.revokedAt) {
      await queryInterface.addColumn('refresh_tokens', 'revokedAt', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('refresh_tokens', 'revokedAt');
  },
};
