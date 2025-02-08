'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Add profile request fields to level_submissions table
    const addColumns = [
      // Charter fields
      ['charterId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'creators',
          key: 'id'
        },
        after: 'charter'
      }],
      ['charterRequest', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        after: 'charterId'
      }],
      // VFXer fields
      ['vfxerId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'creators',
          key: 'id'
        },
        after: 'vfxer'
      }],
      ['vfxerRequest', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        after: 'vfxerId'
      }],
      // Team fields
      ['teamId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'teams',
          key: 'id'
        },
        after: 'team'
      }],
      ['teamRequest', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        after: 'teamId'
      }]
    ];

    // Add each column if it doesn't exist
    const columns = await queryInterface.describeTable('level_submissions');
    for (const [columnName, columnDef] of addColumns) {
      if (!columns[columnName]) {
        await queryInterface.addColumn('level_submissions', columnName, columnDef);
      }
    }
  },

  async down(queryInterface, Sequelize) {
    // Remove all profile request fields
    const columnsToRemove = [
      'charterId',
      'charterRequest',
      'vfxerId',
      'vfxerRequest',
      'teamId',
      'teamRequest'
    ];

    for (const columnName of columnsToRemove) {
      await queryInterface.removeColumn('level_submissions', columnName);
    }
  }
}; 