'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.changeColumn(
        'level_pack_items',
        'type',
        {
          type: Sequelize.ENUM('folder', 'level', 'note'),
          allowNull: false,
          defaultValue: 'level',
          comment: 'Type of item: folder, level, or note',
        },
        { transaction },
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.bulkDelete(
        'level_pack_items',
        { type: 'note' },
        { transaction },
      );

      await queryInterface.changeColumn(
        'level_pack_items',
        'type',
        {
          type: Sequelize.ENUM('folder', 'level'),
          allowNull: false,
          defaultValue: 'level',
          comment: 'Type of item: folder or level',
        },
        { transaction },
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
