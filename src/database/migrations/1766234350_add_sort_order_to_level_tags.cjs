'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Add sort_order column
      await queryInterface.addColumn('level_tags', 'sortOrder', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Sort order for tags display'
      }, { transaction });

      // Set initial sort order based on existing id order
      await queryInterface.sequelize.query(
        `UPDATE level_tags SET sortOrder = id`,
        { transaction }
      );

      // Add index on sort_order for efficient ordering
      await queryInterface.addIndex('level_tags', ['sortOrder'], {
        name: 'idx_level_tags_sort_order',
        transaction
      });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.removeIndex('level_tags', 'idx_level_tags_sort_order', { transaction });
      await queryInterface.removeColumn('level_tags', 'sortOrder', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
