'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // Rank credits only on levels where every row shares the same sortOrder
      // (the column default of 0 after addColumn). Levels that already have
      // distinct ranks from the credits editor are left alone.
      await queryInterface.sequelize.query(
        `
        UPDATE level_credits lc
        INNER JOIN (
          SELECT levelId
          FROM level_credits
          GROUP BY levelId
          HAVING COUNT(*) > 1 AND COUNT(DISTINCT sortOrder) <= 1
        ) stuck ON stuck.levelId = lc.levelId
        INNER JOIN (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY levelId
              ORDER BY
                CASE role
                  WHEN 'charter' THEN 0
                  WHEN 'vfxer' THEN 1
                  WHEN 'specialThanks' THEN 2
                  ELSE 3
                END,
                id ASC
            ) - 1 AS newSortOrder
          FROM level_credits
        ) ranked ON ranked.id = lc.id
        SET lc.sortOrder = ranked.newSortOrder
        `,
        { transaction },
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down() {
    // Non-reversible: original all-zero ranks are not recoverable.
  },
};
