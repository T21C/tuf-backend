'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.changeColumn(
        'level_credits',
        'role',
        {
          type: Sequelize.ENUM('charter', 'vfxer', 'specialThanks'),
          allowNull: false,
        },
        { transaction },
      );

      await queryInterface.changeColumn(
        'level_submission_creator_requests',
        'role',
        {
          type: Sequelize.ENUM('charter', 'vfxer', 'specialThanks'),
          allowNull: false,
        },
        { transaction },
      );

      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(
        `DELETE FROM level_credits WHERE role = 'specialThanks'`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `DELETE FROM level_submission_creator_requests WHERE role = 'specialThanks'`,
        { transaction },
      );

      await queryInterface.changeColumn(
        'level_credits',
        'role',
        {
          type: Sequelize.ENUM('charter', 'vfxer'),
          allowNull: false,
        },
        { transaction },
      );

      await queryInterface.changeColumn(
        'level_submission_creator_requests',
        'role',
        {
          type: Sequelize.ENUM('charter', 'vfxer'),
          allowNull: false,
        },
        { transaction },
      );

      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },
};
