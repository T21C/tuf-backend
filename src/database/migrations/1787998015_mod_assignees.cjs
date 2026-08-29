'use strict';

const MIGRATION = '1787998015_mod_assignees';

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
    await tryStep('addColumn(mods.postedByUserId)', async () => {
      await queryInterface.addColumn('mods', 'postedByUserId', {
        type: Sequelize.UUID,
        allowNull: true,
      });
    });

    await tryStep('addIndex(mods.postedByUserId)', async () => {
      await queryInterface.addIndex('mods', ['postedByUserId'], {
        name: 'idx_mods_posted_by_user_id',
      });
    });

    await tryStep('createTable(mod_assignees)', async () => {
      if (await tableExists(queryInterface, 'mod_assignees')) return;
      await queryInterface.createTable('mod_assignees', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true,
          allowNull: false,
        },
        modId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {model: 'mods', key: 'id'},
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        userId: {
          type: Sequelize.UUID,
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

    await tryStep('addIndex(mod_assignees unique)', async () => {
      await queryInterface.addIndex('mod_assignees', ['modId', 'userId'], {
        unique: true,
        name: 'mod_assignees_mod_user_unique',
      });
    });

    await tryStep('addIndex(mod_assignees.userId)', async () => {
      await queryInterface.addIndex('mod_assignees', ['userId'], {
        name: 'idx_mod_assignees_user_id',
      });
    });
  },

  async down(queryInterface) {
    await tryStep('dropTable(mod_assignees)', async () => {
      if (!(await tableExists(queryInterface, 'mod_assignees'))) return;
      await queryInterface.dropTable('mod_assignees');
    });
    await tryStep('removeIndex(mods.postedByUserId)', async () => {
      await queryInterface.removeIndex('mods', 'idx_mods_posted_by_user_id');
    });
    await tryStep('removeColumn(mods.postedByUserId)', async () => {
      await queryInterface.removeColumn('mods', 'postedByUserId');
    });
  },
};
