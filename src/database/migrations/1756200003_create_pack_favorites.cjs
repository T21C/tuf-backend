'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('pack_favorites', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      packId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'level_packs',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    // Add unique constraint to prevent duplicate favorites
    await queryInterface.addConstraint('pack_favorites', {
      fields: ['userId', 'packId'],
      type: 'unique',
      name: 'unique_user_pack_favorite',
    });

    // Add indexes for better query performance
    await queryInterface.addIndex('pack_favorites', ['userId']);
    await queryInterface.addIndex('pack_favorites', ['packId']);
    await queryInterface.addIndex('pack_favorites', ['userId', 'packId'], {
      unique: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('pack_favorites');
  },
};
