'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('cdn_files', 'type', {
      type: Sequelize.STRING(255),
      allowNull: false,
      defaultValue: 'GENERAL',
      comment: 'The intended use of the file (e.g., profile picture, banner)'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('cdn_files', 'type', {
      type: Sequelize.ENUM('PROFILE', 'BANNER', 'THUMBNAIL', 'LEVELZIP', 'GENERAL'),
      allowNull: false,
      defaultValue: 'GENERAL',
      comment: 'The intended use of the file (e.g., profile picture, banner)'
    });
  }
};
