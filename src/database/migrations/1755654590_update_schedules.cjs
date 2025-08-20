'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      
    await queryInterface.renameColumn('curation_schedules', 'levelId', 'curationId');
    await queryInterface.renameColumn('curation_schedules', 'targetDate', 'weekStart');
    await queryInterface.addColumn('curation_schedules', 'position', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0
    });
    await queryInterface.addColumn('curation_schedules', 'listType', {
      type: Sequelize.STRING,
      allowNull: false,
      defaultValue: 'primary'
    });
    await queryInterface.addColumn('curation_schedules', 'isActive', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true
    });
    await queryInterface.addConstraint('curation_schedules', {
      fields: ['curationId'],
      type: 'foreign key',
      name: 'fk_curation_schedules_curationId',
      references: {
        table: 'curations',
        field: 'id'
      }
    });
    await queryInterface.addIndex('curation_schedules', ['curationId']);
    await queryInterface.addIndex('curation_schedules', ['weekStart']);
    await queryInterface.addIndex('curation_schedules', ['position']);
    await queryInterface.addIndex('curation_schedules', ['listType']);
    await queryInterface.addIndex('curation_schedules', ['isActive']);
    } catch (error) {
      
    }

    // Add indexes
    
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeConstraint('curation_schedules', 'fk_curation_schedules_curationId');
    await queryInterface.renameColumn('curation_schedules', 'curationId', 'levelId');
    await queryInterface.renameColumn('curation_schedules', 'weekStart', 'targetDate');
    await queryInterface.removeIndex('curation_schedules', ['curationId']);
    await queryInterface.removeIndex('curation_schedules', ['weekStart']);
    await queryInterface.removeIndex('curation_schedules', ['position']);
    await queryInterface.removeIndex('curation_schedules', ['listType']);
    await queryInterface.removeIndex('curation_schedules', ['isActive']);
    await queryInterface.removeColumn('curation_schedules', 'position');
    await queryInterface.removeColumn('curation_schedules', 'listType');
    await queryInterface.removeColumn('curation_schedules', 'isActive');
  }
};
