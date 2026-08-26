'use strict';

const MIGRATION = '1787759016_useful_link_groups';

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

async function columnExists(queryInterface, tableName, columnName) {
  try {
    const desc = await queryInterface.describeTable(tableName);
    return Boolean(desc[columnName]);
  } catch (error) {
    console.log(`[${MIGRATION}] describeTable(${tableName}) failed: ${error.message}`);
    return false;
  }
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'useful_links'))) {
      return;
    }

    await tryStep('createTable(useful_link_groups)', async () => {
      await queryInterface.createTable('useful_link_groups', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true,
          allowNull: false,
        },
        name: {
          type: Sequelize.STRING(64),
          allowNull: false,
          unique: true,
        },
        sortOrder: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
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

    await tryStep('addIndex(useful_link_groups.sortOrder)', async () => {
      await queryInterface.addIndex('useful_link_groups', ['sortOrder'], {
        name: 'idx_useful_link_groups_sort_order',
      });
    });

    await tryStep('addColumn(useful_links.groupId)', async () => {
      await queryInterface.addColumn('useful_links', 'groupId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'useful_link_groups',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
    });

    await tryStep('addIndex(useful_links.groupId)', async () => {
      await queryInterface.addIndex('useful_links', ['groupId'], {
        name: 'idx_useful_links_group_id',
      });
    });

    const hasCategory = await columnExists(queryInterface, 'useful_links', 'category');
    const hasGroupId = await columnExists(queryInterface, 'useful_links', 'groupId');

    if (hasCategory && hasGroupId) {
      await tryStep('backfill useful_link_groups from category', async () => {
        const [rows] = await queryInterface.sequelize.query(`
          SELECT DISTINCT TRIM(category) AS name
          FROM useful_links
          WHERE category IS NOT NULL AND CHAR_LENGTH(TRIM(category)) > 0
          ORDER BY TRIM(category)
        `);
        const names = (rows || [])
          .map((row) => String(row.name || '').trim())
          .filter(Boolean);
        const unique = [...new Set(names)];
        for (let i = 0; i < unique.length; i++) {
          await queryInterface.bulkInsert('useful_link_groups', [
            {
              name: unique[i],
              sortOrder: i,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ]);
        }
      });

      await tryStep('link useful_links.groupId from category names', async () => {
        await queryInterface.sequelize.query(`
          UPDATE useful_links ul
          INNER JOIN useful_link_groups g
            ON TRIM(ul.category) = g.name
          SET ul.groupId = g.id
          WHERE ul.category IS NOT NULL AND CHAR_LENGTH(TRIM(ul.category)) > 0
        `);
      });

      await tryStep('removeColumn(useful_links.category)', async () => {
        await queryInterface.removeColumn('useful_links', 'category');
      });
    }
  },

  async down(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'useful_links'))) {
      return;
    }

    await tryStep('addColumn(useful_links.category)', async () => {
      await queryInterface.addColumn('useful_links', 'category', {
        type: Sequelize.STRING(64),
        allowNull: true,
      });
    });

    const hasCategory = await columnExists(queryInterface, 'useful_links', 'category');
    const hasGroupId = await columnExists(queryInterface, 'useful_links', 'groupId');

    if (hasCategory && hasGroupId && (await tableExists(queryInterface, 'useful_link_groups'))) {
      await tryStep('copy group names back to category', async () => {
        await queryInterface.sequelize.query(`
          UPDATE useful_links ul
          INNER JOIN useful_link_groups g ON ul.groupId = g.id
          SET ul.category = g.name
        `);
      });
    }

    await tryStep('removeIndex(idx_useful_links_group_id)', async () => {
      await queryInterface.removeIndex('useful_links', 'idx_useful_links_group_id');
    });

    await tryStep('removeColumn(useful_links.groupId)', async () => {
      await queryInterface.removeColumn('useful_links', 'groupId');
    });

    if (await tableExists(queryInterface, 'useful_link_groups')) {
      await tryStep('dropTable(useful_link_groups)', async () => {
        await queryInterface.dropTable('useful_link_groups');
      });
    }
  },
};
