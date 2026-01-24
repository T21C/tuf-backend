'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {

      // Remove type column from artist_evidences
      await queryInterface.removeColumn('artist_evidences', 'type', { transaction });

      // Remove type column from song_evidences
      await queryInterface.removeColumn('song_evidences', 'type', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Re-add type columns
      await queryInterface.addColumn('artist_evidences', 'type', {
        type: Sequelize.ENUM('official', 'social', 'music_platform', 'other'),
        allowNull: false,
        defaultValue: 'other'
      }, { transaction });

      await queryInterface.addColumn('song_evidences', 'type', {
        type: Sequelize.ENUM('official', 'music_platform', 'video', 'other'),
        allowNull: false,
        defaultValue: 'other'
      }, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
