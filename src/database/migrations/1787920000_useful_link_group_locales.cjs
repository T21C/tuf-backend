'use strict';

const MIGRATION = '1787920000_useful_link_group_locales';

function isIgnorableSchemaError(error) {
  const code = error?.original?.code || error?.parent?.code || error?.code || '';
  const errno = error?.original?.errno || error?.parent?.errno || error?.errno;
  return (
    code === 'ER_TABLE_EXISTS_ERROR' ||
    code === 'ER_DUP_FIELDNAME' ||
    code === 'ER_DUP_KEYNAME' ||
    code === 'ER_CANT_DROP_FIELD_OR_KEY' ||
    code === 'ER_DUP_ENTRY' ||
    errno === 1050 ||
    errno === 1060 ||
    errno === 1061 ||
    errno === 1091 ||
    errno === 1062
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
    if (!(await tableExists(queryInterface, 'useful_link_groups'))) {
      return;
    }

    await tryStep('createTable(useful_link_group_locales)', async () => {
      await queryInterface.createTable('useful_link_group_locales', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true,
          allowNull: false,
        },
        groupId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'useful_link_groups',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        languageCode: {
          type: Sequelize.STRING(8),
          allowNull: false,
        },
        name: {
          type: Sequelize.STRING(64),
          allowNull: false,
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

    await tryStep('add unique index useful_link_group_locales_group_language_unique', async () => {
      await queryInterface.addIndex('useful_link_group_locales', ['groupId', 'languageCode'], {
        unique: true,
        name: 'useful_link_group_locales_group_language_unique',
      });
    });

    await tryStep('addIndex(useful_link_group_locales.languageCode)', async () => {
      await queryInterface.addIndex('useful_link_group_locales', ['languageCode'], {
        name: 'idx_useful_link_group_locales_language',
      });
    });

    await tryStep('backfill en locales from useful_link_groups', async () => {
      await queryInterface.sequelize.query(`
        INSERT INTO useful_link_group_locales (groupId, languageCode, name, createdAt, updatedAt)
        SELECT id, 'en', name, createdAt, updatedAt
        FROM useful_link_groups
        WHERE id NOT IN (
          SELECT groupId FROM useful_link_group_locales WHERE languageCode = 'en'
        )
      `);
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'useful_link_group_locales')) {
      await queryInterface.dropTable('useful_link_group_locales');
    }
  },
};
