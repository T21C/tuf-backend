'use strict';

/**
 * Verified YouTube channel links (ownership via OAuth). Separate from
 * user_oauth_providers so YouTube cannot be used as a sign-in method.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('user_youtube_channels')) {
        await queryInterface.createTable(
          'user_youtube_channels',
          {
            id: {
              type: Sequelize.INTEGER,
              primaryKey: true,
              autoIncrement: true,
              allowNull: false,
            },
            userId: {
              type: Sequelize.UUID,
              allowNull: false,
              references: {model: 'users', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            channelId: {
              type: Sequelize.STRING(64),
              allowNull: false,
            },
            title: {
              type: Sequelize.STRING(255),
              allowNull: false,
              defaultValue: '',
            },
            handle: {
              type: Sequelize.STRING(255),
              allowNull: true,
            },
            isPrimary: {
              type: Sequelize.BOOLEAN,
              allowNull: false,
              defaultValue: false,
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
        await queryInterface.addIndex('user_youtube_channels', ['channelId'], {
          unique: true,
          name: 'user_youtube_channels_channel_id_unique',
          transaction,
        });
        await queryInterface.addIndex('user_youtube_channels', ['userId'], {
          name: 'user_youtube_channels_user_id',
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
      if (names.includes('user_youtube_channels')) {
        await queryInterface.dropTable('user_youtube_channels', {transaction});
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
