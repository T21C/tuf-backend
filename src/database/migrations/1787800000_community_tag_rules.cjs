'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'level_tag_votes',
        'direction',
        {
          type: Sequelize.TINYINT,
          allowNull: false,
          defaultValue: 1,
          comment: '1 upvote, -1 downvote',
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'level_tags',
        'description',
        {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        { transaction },
      );

      const tagKnobColumns = [
        ['wilsonZ', Sequelize.DOUBLE],
        ['scoreOn', Sequelize.DOUBLE],
        ['scoreOff', Sequelize.DOUBLE],
      ];
      for (const [name, type] of tagKnobColumns) {
        await queryInterface.addColumn(
          'level_tags',
          name,
          { type, allowNull: true },
          { transaction },
        );
        await queryInterface.addColumn(
          'level_tag_groups',
          name,
          { type, allowNull: true },
          { transaction },
        );
      }

      await queryInterface.addColumn(
        'level_tags',
        'scoringMode',
        {
          type: Sequelize.STRING(16),
          allowNull: true,
          comment: 'wilson | skillset; null inherits group then wilson',
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'level_tag_groups',
        'scoringMode',
        {
          type: Sequelize.STRING(16),
          allowNull: true,
          comment: 'wilson | skillset; null means wilson',
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'level_tags',
        'allowedBands',
        {
          type: Sequelize.JSON,
          allowNull: true,
          comment: 'PGU bands P/G/U; null inherits group then all',
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'level_tag_groups',
        'allowedBands',
        {
          type: Sequelize.JSON,
          allowNull: true,
          comment: 'PGU bands P/G/U; null means all difficulties',
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
      await queryInterface.removeColumn('level_tag_votes', 'direction', { transaction });
      await queryInterface.removeColumn('level_tags', 'description', { transaction });
      for (const name of ['wilsonZ', 'scoreOn', 'scoreOff', 'scoringMode', 'allowedBands']) {
        await queryInterface.removeColumn('level_tags', name, { transaction });
        await queryInterface.removeColumn('level_tag_groups', name, { transaction });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
