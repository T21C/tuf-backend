'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('user_follows', 'notifyLevel', {
      type: Sequelize.ENUM('all', 'none'),
      allowNull: false,
      defaultValue: 'all',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('user_follows', 'notifyLevel');
  },
};
