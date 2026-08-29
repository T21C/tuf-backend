'use strict';

const MIGRATION = '1787990852_create_mods';

function isIgnorableSchemaError(error) {
  const code = error?.original?.code || error?.parent?.code || error?.code || '';
  const errno = error?.original?.errno || error?.parent?.errno || error?.errno;
  return (
    code === 'ER_TABLE_EXISTS_ERROR' ||
    code === 'ER_DUP_FIELDNAME' ||
    code === 'ER_DUP_KEYNAME' ||
    code === 'ER_CANT_DROP_FIELD_OR_KEY' ||
    errno === 1050 ||
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

async function tableExists(queryInterface, tableName) {
  const tables = await queryInterface.showAllTables();
  const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));
  return names.includes(tableName);
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await tryStep('createTable(mods)', async () => {
      if (await tableExists(queryInterface, 'mods')) return;
      await queryInterface.createTable('mods', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true,
          allowNull: false,
        },
        name: {
          type: Sequelize.STRING(512),
          allowNull: false,
        },
        creatorUsername: {
          type: Sequelize.STRING(64),
          allowNull: false,
        },
        creatorDiscordId: {
          type: Sequelize.STRING(32),
          allowNull: false,
        },
        version: {
          type: Sequelize.STRING(64),
          allowNull: true,
        },
        description: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        downloadUrl: {
          type: Sequelize.TEXT,
          allowNull: false,
        },
        imageUrl: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        sourceUploadedAt: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        hidden: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
      });
    });

    await tryStep('addIndex(mods.hidden)', async () => {
      await queryInterface.addIndex('mods', ['hidden'], {
        name: 'idx_mods_hidden',
      });
    });
  },

  async down(queryInterface) {
    await tryStep('dropTable(mods)', async () => {
      if (!(await tableExists(queryInterface, 'mods'))) return;
      await queryInterface.dropTable('mods');
    });
  },
};
