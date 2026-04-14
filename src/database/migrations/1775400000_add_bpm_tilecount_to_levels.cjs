'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'levels',
        'bpm',
        {
          type: Sequelize.DOUBLE,
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'levels',
        'tilecount',
        {
          type: Sequelize.INTEGER,
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );

      // Backfill from cdn_files.cacheData (same DB). UUID must match getFileIdFromCdnUrl single-match rule.
      await queryInterface.sequelize.query(
        `
        UPDATE levels l
        INNER JOIN cdn_files cf
          ON cf.id = REGEXP_SUBSTR(
            l.dlLink,
            '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
          )
        SET
          l.bpm = IF(
            JSON_VALID(cf.cacheData),
            CAST(JSON_UNQUOTE(JSON_EXTRACT(cf.cacheData, '$.settings.bpm')) AS DOUBLE),
            NULL
          ),
          l.tilecount = IF(
            JSON_VALID(cf.cacheData),
            FLOOR(CAST(JSON_EXTRACT(cf.cacheData, '$.tilecount') AS DECIMAL(20, 10))),
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
      await queryInterface.removeColumn('levels', 'tilecount', { transaction });
      await queryInterface.removeColumn('levels', 'bpm', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
