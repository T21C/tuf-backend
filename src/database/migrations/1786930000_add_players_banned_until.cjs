'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'players',
        'bannedUntil',
        {
          type: Sequelize.DATE,
          allowNull: true,
          defaultValue: null,
          comment: 'Temporary ban expiry. Null with isBanned means permanent / not timed.',
        },
        { transaction },
      );

      await queryInterface.addIndex('players', ['bannedUntil'], {
        name: 'players_banned_until',
        transaction,
      });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeIndex('players', 'players_banned_until', { transaction });
      await queryInterface.removeColumn('players', 'bannedUntil', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
