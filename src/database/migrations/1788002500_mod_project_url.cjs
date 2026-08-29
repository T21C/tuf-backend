'use strict';

const MIGRATION = '1788002500_mod_project_url';

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

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await tryStep('addColumn(mods.projectUrl)', async () => {
      await queryInterface.addColumn('mods', 'projectUrl', {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    });
  },

  async down(queryInterface) {
    await tryStep('removeColumn(mods.projectUrl)', async () => {
      await queryInterface.removeColumn('mods', 'projectUrl');
    });
  },
};
