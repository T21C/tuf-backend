'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'levels',
        'ppDiffId',
        {
          type: Sequelize.INTEGER,
          allowNull: true,
          defaultValue: null,
          references: {
            model: 'difficulties',
            key: 'id',
          },
        },
        {transaction},
      );

      await queryInterface.sequelize.query(
        `
        UPDATE levels l
        SET ppDiffId = (
          SELECT d.id
          FROM difficulties d
          WHERE d.type <> 'LEGACY'
            AND d.baseScore <= l.ppBaseScore
          ORDER BY d.baseScore DESC, d.sortOrder DESC
          LIMIT 1
        )
        WHERE l.ppBaseScore > 0
        `,
        {transaction},
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
      await queryInterface.removeColumn('levels', 'ppDiffId', {transaction});
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
