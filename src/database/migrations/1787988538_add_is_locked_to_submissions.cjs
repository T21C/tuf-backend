'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'pass_submissions',
        'isLocked',
        {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
          comment: 'Admin lock parks the submission at the bottom of the pending queue',
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'level_submissions',
        'isLocked',
        {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
          comment: 'Admin lock parks the submission at the bottom of the pending queue',
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
      await queryInterface.removeColumn('pass_submissions', 'isLocked', { transaction });
      await queryInterface.removeColumn('level_submissions', 'isLocked', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
