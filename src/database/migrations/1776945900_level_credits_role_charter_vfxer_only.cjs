'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface.sequelize;
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await qi.query(
        `
        DELETE lc FROM level_credits lc
        INNER JOIN level_credits ch
          ON ch.levelId = lc.levelId
          AND ch.creatorId = lc.creatorId
          AND ch.role = 'charter'
          AND ch.id <> lc.id
        WHERE lc.role IN ('creator', 'team_member')
        `,
        { transaction },
      );

      await qi.query(
        `
        DELETE lc FROM level_credits lc
        INNER JOIN level_credits other
          ON other.levelId = lc.levelId
          AND other.creatorId = lc.creatorId
          AND other.role IN ('creator', 'team_member')
          AND other.id < lc.id
        WHERE lc.role IN ('creator', 'team_member')
        `,
        { transaction },
      );

      await qi.query(
        `UPDATE level_credits SET role = 'charter' WHERE role IN ('creator', 'team_member')`,
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

      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.changeColumn(
        'level_credits',
        'role',
        {
          type: Sequelize.ENUM('creator', 'charter', 'vfxer', 'team_member'),
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
