'use strict';

/**
 * Encrypted Google refresh tokens for linked YouTube channels.
 * Kept off user_youtube_channels so profile reads never select the secret.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('user_youtube_channel_credentials')) {
        await queryInterface.createTable(
          'user_youtube_channel_credentials',
          {
            userYoutubeChannelId: {
              type: Sequelize.INTEGER,
              allowNull: false,
              primaryKey: true,
              references: {model: 'user_youtube_channels', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            refreshToken: {
              type: Sequelize.TEXT,
              allowNull: false,
            },
            createdAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
            updatedAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
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
      if (names.includes('user_youtube_channel_credentials')) {
        await queryInterface.dropTable('user_youtube_channel_credentials', {transaction});
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
