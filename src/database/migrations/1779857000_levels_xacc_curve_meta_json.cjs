'use strict';

/** Migrate per-level xacc knobs from discrete columns into one JSON blob. */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'levels',
        'xaccCurveMeta',
        {
          type: Sequelize.JSON,
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );

      const [rows] = await queryInterface.sequelize.query(
        `SELECT id, xaccPoleOffset, xaccTopMultiplier FROM levels WHERE xaccPoleOffset IS NOT NULL OR xaccTopMultiplier IS NOT NULL`,
        { transaction },
      );

      for (const row of rows) {
        const meta = {};
        if (row.xaccPoleOffset != null && row.xaccPoleOffset !== '') {
          meta.poleOffset = Number(row.xaccPoleOffset);
        }
        if (row.xaccTopMultiplier != null && row.xaccTopMultiplier !== '') {
          meta.topMultiplier = Number(row.xaccTopMultiplier);
        }
        if (Object.keys(meta).length === 0) continue;
        await queryInterface.sequelize.query(
          `UPDATE levels SET xaccCurveMeta = :meta WHERE id = :id`,
          {
            replacements: {
              meta: JSON.stringify(meta),
              id: row.id,
            },
            transaction,
          },
        );
      }

      await queryInterface.removeColumn('levels', 'xaccTopMultiplier', { transaction });
      await queryInterface.removeColumn('levels', 'xaccPoleOffset', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'levels',
        'xaccPoleOffset',
        {
          type: Sequelize.DOUBLE,
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'levels',
        'xaccTopMultiplier',
        {
          type: Sequelize.DOUBLE,
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );

      const [rows] = await queryInterface.sequelize.query(
        `SELECT id, xaccCurveMeta FROM levels WHERE xaccCurveMeta IS NOT NULL`,
        { transaction },
      );

      for (const row of rows) {
        let parsed = row.xaccCurveMeta;
        if (typeof parsed === 'string') {
          try {
            parsed = JSON.parse(parsed);
          } catch {
            continue;
          }
        }
        if (!parsed || typeof parsed !== 'object') continue;
        const pole =
          parsed.poleOffset != null && Number.isFinite(Number(parsed.poleOffset))
            ? Number(parsed.poleOffset)
            : null;
        const top =
          parsed.topMultiplier != null && Number.isFinite(Number(parsed.topMultiplier))
            ? Number(parsed.topMultiplier)
            : null;
        await queryInterface.sequelize.query(
          `UPDATE levels SET xaccPoleOffset = :pole, xaccTopMultiplier = :top WHERE id = :id`,
          {
            replacements: { pole, top, id: row.id },
            transaction,
          },
        );
      }

      await queryInterface.removeColumn('levels', 'xaccCurveMeta', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
