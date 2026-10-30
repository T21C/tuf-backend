'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const ratings = await queryInterface.describeTable('ratings');
    if (!ratings.autoraterCombined) {
      await queryInterface.addColumn('ratings', 'autoraterCombined', {
        type: Sequelize.JSON,
        allowNull: true,
      });
    }
    if (!ratings.autoRankBlockedBy) {
      await queryInterface.addColumn('ratings', 'autoRankBlockedBy', {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
    }
    if (!ratings.autoRankBlockReason) {
      await queryInterface.addColumn('ratings', 'autoRankBlockReason', {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }
    if (!ratings.autoRankBlockedAt) {
      await queryInterface.addColumn('ratings', 'autoRankBlockedAt', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }

    const tags = await queryInterface.describeTable('level_tags');
    if (!tags.charterManagable) {
      await queryInterface.addColumn('level_tags', 'charterManagable', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    }
  },

  async down(queryInterface) {
    const ratings = await queryInterface.describeTable('ratings');
    if (ratings.autoRankBlockedAt) await queryInterface.removeColumn('ratings', 'autoRankBlockedAt');
    if (ratings.autoRankBlockReason) await queryInterface.removeColumn('ratings', 'autoRankBlockReason');
    if (ratings.autoRankBlockedBy) await queryInterface.removeColumn('ratings', 'autoRankBlockedBy');
    if (ratings.autoraterCombined) await queryInterface.removeColumn('ratings', 'autoraterCombined');
    const tags = await queryInterface.describeTable('level_tags');
    if (tags.charterManagable) await queryInterface.removeColumn('level_tags', 'charterManagable');
  },
};
