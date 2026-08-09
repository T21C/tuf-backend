'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('curations', 'isDuplicate', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment:
        'Duplicate curation of another level variant; excluded from creator earned-type counts',
    });
    await queryInterface.addIndex('curations', ['isDuplicate'], {
      name: 'curations_is_duplicate',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('curations', 'curations_is_duplicate');
    await queryInterface.removeColumn('curations', 'isDuplicate');
  },
};
