'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'level_tags',
        'requireTopPlay',
        {
          type: Sequelize.BOOLEAN,
          allowNull: true,
          comment: 'Require top play + 1 to vote; null inherits group then true',
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'level_tag_groups',
        'requireTopPlay',
        {
          type: Sequelize.BOOLEAN,
          allowNull: true,
          comment: 'Require top play + 1 to vote; null means true',
        },
        { transaction },
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeColumn('level_tags', 'requireTopPlay', { transaction });
      await queryInterface.removeColumn('level_tag_groups', 'requireTopPlay', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
