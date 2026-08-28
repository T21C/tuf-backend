'use strict';

const MIGRATION = '1787910000_useful_link_shorthand';

function isIgnorableSchemaError(error) {
  const code = error?.original?.code || error?.parent?.code || error?.code || '';
  const errno = error?.original?.errno || error?.parent?.errno || error?.errno;
  return (
    code === 'ER_DUP_FIELDNAME' ||
    code === 'ER_CANT_DROP_FIELD_OR_KEY' ||
    errno === 1060 ||
    errno === 1091
  );
}

async function tryStep(label, fn) {
  try {
    await fn();
  } catch (error) {
    if (isIgnorableSchemaError(error)) {
      console.log(`[${MIGRATION}] skip ${label}: ${error.message}`);
      return;
    }
    console.error(`[${MIGRATION}] failed ${label}:`, error.message);
    throw error;
  }
}

async function columnExists(queryInterface, tableName, columnName) {
  try {
    const desc = await queryInterface.describeTable(tableName);
    return Boolean(desc[columnName]);
  } catch (error) {
    console.log(`[${MIGRATION}] describeTable(${tableName}) failed: ${error.message}`);
    return false;
  }
}

const shorthandColumn = (Sequelize) => ({
  type: Sequelize.STRING(64),
  allowNull: true,
});

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await tryStep('addColumn(useful_links.shorthand)', async () => {
      if (await columnExists(queryInterface, 'useful_links', 'shorthand')) return;
      await queryInterface.addColumn('useful_links', 'shorthand', shorthandColumn(Sequelize));
    });
    await tryStep('addColumn(useful_link_locales.shorthand)', async () => {
      if (await columnExists(queryInterface, 'useful_link_locales', 'shorthand')) return;
      await queryInterface.addColumn(
        'useful_link_locales',
        'shorthand',
        shorthandColumn(Sequelize),
      );
    });
  },

  async down(queryInterface) {
    await tryStep('removeColumn(useful_link_locales.shorthand)', async () => {
      if (!(await columnExists(queryInterface, 'useful_link_locales', 'shorthand'))) return;
      await queryInterface.removeColumn('useful_link_locales', 'shorthand');
    });
    await tryStep('removeColumn(useful_links.shorthand)', async () => {
      if (!(await columnExists(queryInterface, 'useful_links', 'shorthand'))) return;
      await queryInterface.removeColumn('useful_links', 'shorthand');
    });
  },
};
