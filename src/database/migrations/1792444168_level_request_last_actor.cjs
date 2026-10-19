'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('level_requests');
    if (table.lastActorUserId) return;
    await queryInterface.addColumn('level_requests', 'lastActorUserId', {
      type: Sequelize.UUID,
      allowNull: true,
      references: {model: 'users', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('level_requests');
    if (!table.lastActorUserId) return;
    await queryInterface.removeColumn('level_requests', 'lastActorUserId');
  },
};
