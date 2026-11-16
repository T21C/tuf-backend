'use strict';

/** @type {import('sequelize-cli').Migration} */

async function indexExists(sequelize, table, name) {
  const [rows] = await sequelize.query(
    `SHOW INDEX FROM \`${table}\` WHERE Key_name = :name`,
    {replacements: {name}},
  );
  return Array.isArray(rows) && rows.length > 0;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const sequelize = queryInterface.sequelize;
    const transaction = await sequelize.transaction();
    try {
      const desc = await queryInterface.describeTable('tufstellar_nominee_months');
      if (!desc.kind) {
        await queryInterface.addColumn(
          'tufstellar_nominee_months',
          'kind',
          {
            type: Sequelize.STRING(16),
            allowNull: false,
            defaultValue: 'rating',
          },
          {transaction},
        );
      }

      const oldName = 'uniq_tufstellar_nominee_months_user_month';
      const newName = 'uniq_tufstellar_nominee_months_user_month_kind';
      // The userId foreign key uses the old unique index as its leftmost prefix.
      // Create the replacement before dropping it.
      if (!(await indexExists(sequelize, 'tufstellar_nominee_months', newName))) {
        await queryInterface.addIndex(
          'tufstellar_nominee_months',
          ['userId', 'monthKey', 'kind'],
          {unique: true, name: newName, transaction},
        );
      }
      if (await indexExists(sequelize, 'tufstellar_nominee_months', oldName)) {
        await queryInterface.removeIndex('tufstellar_nominee_months', oldName, {transaction});
      }

      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const transaction = await sequelize.transaction();
    try {
      await queryInterface.bulkDelete(
        'tufstellar_nominee_months',
        {kind: 'curation'},
        {transaction},
      );

      const oldName = 'uniq_tufstellar_nominee_months_user_month';
      const newName = 'uniq_tufstellar_nominee_months_user_month_kind';
      if (!(await indexExists(sequelize, 'tufstellar_nominee_months', oldName))) {
        await queryInterface.addIndex('tufstellar_nominee_months', ['userId', 'monthKey'], {
          unique: true,
          name: oldName,
          transaction,
        });
      }
      if (await indexExists(sequelize, 'tufstellar_nominee_months', newName)) {
        await queryInterface.removeIndex('tufstellar_nominee_months', newName, {transaction});
      }
      const desc = await queryInterface.describeTable('tufstellar_nominee_months');
      if (desc.kind) {
        await queryInterface.removeColumn('tufstellar_nominee_months', 'kind', {transaction});
      }

      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },
};
