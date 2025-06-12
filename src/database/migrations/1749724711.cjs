'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('pass_submissions', 'userId', {
      type: Sequelize.UUID,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id',
      },
    });

  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('pass_submissions', 'userId');
  }
};