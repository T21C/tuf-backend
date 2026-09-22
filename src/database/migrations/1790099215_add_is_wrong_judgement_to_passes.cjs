'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addColumn('passes', 'isWrongJudgement', {
      type: require('sequelize').BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Hit total does not match chart tilecount minus auto tiles',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('passes', 'isWrongJudgement');
  },
};
