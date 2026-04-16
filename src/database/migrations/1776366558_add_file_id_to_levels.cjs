'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'levels',
        'fileId',
        {
          type: Sequelize.CHAR(36),
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );

      await queryInterface.addIndex('levels', ['fileId'], {
        name: 'idx_levels_file_id',
        transaction,
      });

      // Backfill `fileId` from `dlLink` using the same single-UUID rule as
      // `getFileIdFromCdnUrl` (server/src/misc/utils/Utility.ts):
      //   - must start with CDN_CONFIG.baseUrl (process.env.CDN_URL)
      //   - must contain exactly one UUID occurrence
      // The length-math `(len(dlLink) - len(stripped)) / 36 === 1` enforces
      // the "exactly one UUID" constraint.
      const cdnUrl = process.env.CDN_URL;
      if (!cdnUrl) {
        throw new Error('CDN_URL must be set to run add_file_id_to_levels backfill');
      }

      await queryInterface.sequelize.query(
        `
        UPDATE levels
        SET fileId = REGEXP_SUBSTR(
          dlLink,
          '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
        )
        WHERE dlLink IS NOT NULL
          AND dlLink <> ''
          AND dlLink <> 'removed'
          AND dlLink LIKE :prefix
          AND (
            CHAR_LENGTH(dlLink) - CHAR_LENGTH(
              REGEXP_REPLACE(
                dlLink,
                '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',
                ''
              )
            )
          ) / 36 = 1
        `,
        {
          transaction,
          replacements: { prefix: `${cdnUrl}%` },
        },
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
      try {
        await queryInterface.removeIndex('levels', 'idx_levels_file_id', { transaction });
      } catch (e) {
        // Index may already be gone; continue to drop the column.
      }
      await queryInterface.removeColumn('levels', 'fileId', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
