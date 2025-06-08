'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('cdn_files', 'filePath', {
      type: Sequelize.TEXT,
      allowNull: false,
    });

    await queryInterface.changeColumn('file_access_logs', 'userAgent', {
      type: Sequelize.TEXT,
      allowNull: false,
    });

  },

  async down(queryInterface, Sequelize) {
    console.log('strings dont fit brocachino');
  }
};