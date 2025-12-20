'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Add groupSortOrder column
      await queryInterface.addColumn('level_tags', 'groupSortOrder', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Sort order for tag groups display'
      }, { transaction });

      // Set initial groupSortOrder based on group's first appearance order
      // Tags with the same group will share the same groupSortOrder
      // Using JOIN with derived table to work around MySQL limitation
      await queryInterface.sequelize.query(`
        UPDATE level_tags lt
        JOIN (
          SELECT COALESCE(\`group\`, '') as group_key, MIN(id) as min_id
          FROM level_tags
          GROUP BY COALESCE(\`group\`, '')
        ) AS group_mins ON COALESCE(lt.\`group\`, '') = group_mins.group_key
        SET lt.groupSortOrder = group_mins.min_id
      `, { transaction });

      // Add index on groupSortOrder for efficient ordering
      await queryInterface.addIndex('level_tags', ['groupSortOrder'], {
        name: 'idx_level_tags_group_sort_order',
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
      await queryInterface.removeIndex('level_tags', 'idx_level_tags_group_sort_order', { transaction });
      await queryInterface.removeColumn('level_tags', 'groupSortOrder', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
