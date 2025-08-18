'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('curation_schedules', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      levelId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'levels',
          key: 'id'
        },
        onDelete: 'CASCADE'
      },
      targetDate: {
        type: Sequelize.DATE,
        allowNull: false,
        comment: 'Target date for when this curation should be featured'
      },
      isActive: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      scheduledBy: {
        type: Sequelize.STRING,
        allowNull: false,
        comment: 'Discord ID of the person who scheduled this'
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    // Add indexes
    await queryInterface.addIndex('curation_schedules', ['levelId']);
    await queryInterface.addIndex('curation_schedules', ['targetDate']);
    await queryInterface.addIndex('curation_schedules', ['isActive']);
    await queryInterface.addIndex('curation_schedules', ['scheduledBy']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('curation_schedules');
  }
};
