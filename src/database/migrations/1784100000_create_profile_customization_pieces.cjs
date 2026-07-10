'use strict';

/** Creates `profile_customization_pieces` for per-unit player/creator presentation sync. */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const t = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable(
        'profile_customization_pieces',
        {
          id: {
            type: Sequelize.INTEGER,
            autoIncrement: true,
            primaryKey: true,
          },
          userId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: 'users', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          playerId: {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: 'players', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          creatorId: {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: 'creators', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          unit: {
            type: Sequelize.ENUM('banner', 'header_surface', 'bio', 'stellar_icon'),
            allowNull: false,
          },
          payload: {
            type: Sequelize.JSON,
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
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
          },
        },
        { transaction: t },
      );

      await queryInterface.addIndex('profile_customization_pieces', ['userId'], {
        name: 'idx_profile_customization_pieces_user_id',
        transaction: t,
      });

      await queryInterface.addIndex('profile_customization_pieces', ['playerId', 'unit'], {
        name: 'uniq_profile_customization_pieces_player_unit',
        unique: true,
        transaction: t,
      });

      await queryInterface.addIndex('profile_customization_pieces', ['creatorId', 'unit'], {
        name: 'uniq_profile_customization_pieces_creator_unit',
        unique: true,
        transaction: t,
      });

      // MySQL rejects CHECK constraints on columns referenced by FKs with ON DELETE/UPDATE
      // actions. Enforce "playerId OR creatorId" in ProfileCustomizationPiece model + service.

      await t.commit();
    } catch (error) {
      await t.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const t = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.dropTable('profile_customization_pieces', { transaction: t });
      await t.commit();
    } catch (error) {
      await t.rollback();
      throw error;
    }
  },
};
