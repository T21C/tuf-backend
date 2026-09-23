'use strict';

const MIGRATION = '1790168749_bot_mods_is_duplicate';

function isIgnorableSchemaError(error) {
  const code = error?.original?.code || error?.parent?.code || error?.code || '';
  const errno = error?.original?.errno || error?.parent?.errno || error?.errno;
  return (
    code === 'ER_DUP_FIELDNAME' ||
    code === 'ER_DUP_KEYNAME' ||
    code === 'ER_CANT_DROP_FIELD_OR_KEY' ||
    errno === 1060 ||
    errno === 1061 ||
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
    await tryStep('addColumn(bot_mods.isDuplicate)', async () => {
      await queryInterface.addColumn('bot_mods', 'isDuplicate', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    });
    await tryStep('addIndex(bot_mods.isDuplicate)', async () => {
      await queryInterface.addIndex('bot_mods', ['isDuplicate'], {
        name: 'idx_bot_mods_is_duplicate',
      });
    });
  },

  async down(queryInterface) {
    await tryStep('removeIndex(bot_mods.isDuplicate)', async () => {
      await queryInterface.removeIndex('bot_mods', 'idx_bot_mods_is_duplicate');
    });
    await tryStep('removeColumn(bot_mods.isDuplicate)', async () => {
      await queryInterface.removeColumn('bot_mods', 'isDuplicate');
    });
  },
};
