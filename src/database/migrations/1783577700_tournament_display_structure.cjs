'use strict';

/** @param {import('sequelize').QueryInterface} queryInterface @param {import('sequelize')} Sequelize */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('players', 'placementDisplayMode', {
      type: Sequelize.ENUM('defaultHierarchy', 'customLayers'),
      allowNull: false,
      defaultValue: 'defaultHierarchy',
    });
    await queryInterface.addColumn('creators', 'placementDisplayMode', {
      type: Sequelize.ENUM('defaultHierarchy', 'customLayers'),
      allowNull: false,
      defaultValue: 'defaultHierarchy',
    });

    await queryInterface.createTable('placement_display_nodes', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      playerId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {model: 'players', key: 'id'},
        onDelete: 'CASCADE',
      },
      creatorId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {model: 'creators', key: 'id'},
        onDelete: 'CASCADE',
      },
      parentId: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      sortOrder: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      visible: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      nodeType: {
        type: Sequelize.ENUM('group', 'credit', 'seriesRef', 'tournamentRef'),
        allowNull: false,
      },
      refId: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      label: {
        type: Sequelize.STRING(255),
        allowNull: true,
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
    });

    await queryInterface.addIndex('placement_display_nodes', ['playerId']);
    await queryInterface.addIndex('placement_display_nodes', ['creatorId']);
    await queryInterface.addIndex('placement_display_nodes', ['parentId']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('placement_display_nodes');
    await queryInterface.removeColumn('creators', 'placementDisplayMode');
    await queryInterface.removeColumn('players', 'placementDisplayMode');
  },
};
