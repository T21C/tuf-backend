'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('ratings');
    if (!table.discordMessageUrl) {
      await queryInterface.addColumn('ratings', 'discordMessageUrl', {
        type: Sequelize.STRING(512),
        allowNull: true,
      });
    }
    if (!table.discordPostError) {
      await queryInterface.addColumn('ratings', 'discordPostError', {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('ratings');
    if (table.discordPostError) {
      await queryInterface.removeColumn('ratings', 'discordPostError');
    }
    if (table.discordMessageUrl) {
      await queryInterface.removeColumn('ratings', 'discordMessageUrl');
    }
  },
};
