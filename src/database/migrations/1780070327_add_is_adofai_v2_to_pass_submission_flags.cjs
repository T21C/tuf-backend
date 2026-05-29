'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addColumn('pass_submission_flags', 'isAdofaiV2', {
      type: require('sequelize').BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Clear recorded on ADOFAI v2 (pre-v3 release timing)',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('pass_submission_flags', 'isAdofaiV2');
  },
};
