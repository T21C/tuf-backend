'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('level_rerate_histories', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      levelId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'levels', key: 'id' },
      },
      previousDiffId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'difficulties', key: 'id' },
      },
      newDiffId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'difficulties', key: 'id' },
      },
      previousBaseScore: {
        type: Sequelize.FLOAT,
        allowNull: false,
      },
      newBaseScore: {
        type: Sequelize.FLOAT,
        allowNull: false,
      },
      reratedBy: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('level_rerate_histories');
  }
}; 