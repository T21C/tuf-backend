'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'levels',
        'midspinCount',
        {
          type: Sequelize.INTEGER,
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );

      await queryInterface.sequelize.query(
        `
        UPDATE levels l
        INNER JOIN cdn_files cf
          ON cf.id = REGEXP_SUBSTR(
            l.dlLink,
            '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
          )
        SET
          l.midspinCount = IF(
            JSON_VALID(cf.cacheData),
            CAST(JSON_UNQUOTE(JSON_EXTRACT(cf.cacheData, '$.analysis.midspinCount')) AS SIGNED),
            NULL
          )
        WHERE l.dlLink IS NOT NULL
          AND l.dlLink <> 'removed'
          AND cf.cacheData IS NOT NULL
          AND JSON_VALID(cf.cacheData)
        `,
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
      await queryInterface.removeColumn('levels', 'midspinCount', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
