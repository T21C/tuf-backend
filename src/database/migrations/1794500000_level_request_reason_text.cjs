'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('level_requests');
    if (!table.reason) return;
    await queryInterface.changeColumn('level_requests', 'reason', {
      type: Sequelize.TEXT,
      allowNull: false,
    });
  },

  async down(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('level_requests');
    if (!table.reason) return;
    await queryInterface.changeColumn('level_requests', 'reason', {
      type: Sequelize.STRING(1000),
      allowNull: false,
      defaultValue: '',
    });
  },
};
