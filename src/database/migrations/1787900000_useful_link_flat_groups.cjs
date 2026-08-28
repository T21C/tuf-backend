'use strict';

const MIGRATION = '1787900000_useful_link_flat_groups';

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
    const dropTables = [
      'useful_link_cluster_locale_defaults',
      'useful_link_cluster_items',
      'useful_link_clusters',
      'useful_link_tag_assignments',
      'useful_link_tags',
      'useful_link_tag_groups',
    ];
    for (const tableName of dropTables) {
      await tryStep(`dropTable(${tableName})`, async () => {
        if (!(await tableExists(queryInterface, tableName))) return;
        await queryInterface.dropTable(tableName);
      });
    }

    await tryStep('removeIndex(useful_links.ownerId)', async () => {
      await queryInterface.removeIndex('useful_links', 'idx_useful_links_owner_id');
    });
    await tryStep('removeIndex(useful_links.isCatalog)', async () => {
      await queryInterface.removeIndex('useful_links', 'idx_useful_links_is_catalog');
    });
    await tryStep('removeColumn(useful_links.ownerId)', async () => {
      if (!(await columnExists(queryInterface, 'useful_links', 'ownerId'))) return;
      await queryInterface.removeColumn('useful_links', 'ownerId');
    });
    await tryStep('removeColumn(useful_links.isCatalog)', async () => {
      if (!(await columnExists(queryInterface, 'useful_links', 'isCatalog'))) return;
      await queryInterface.removeColumn('useful_links', 'isCatalog');
    });
    await tryStep('removeColumn(useful_links.isPublished)', async () => {
      if (!(await columnExists(queryInterface, 'useful_links', 'isPublished'))) return;
      await queryInterface.removeColumn('useful_links', 'isPublished');
    });

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

    await tryStep('createTable(useful_link_group_assignments)', async () => {
      await queryInterface.createTable('useful_link_group_assignments', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true,
          allowNull: false,
        },
        linkId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'useful_links',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
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
    await tryStep('addIndex(useful_link_group_assignments unique)', async () => {
      await queryInterface.addIndex('useful_link_group_assignments', ['linkId', 'groupId'], {
        unique: true,
        name: 'useful_link_group_assignments_unique',
      });
    });
    await tryStep('addIndex(useful_link_group_assignments.groupId)', async () => {
      await queryInterface.addIndex('useful_link_group_assignments', ['groupId'], {
        name: 'idx_useful_link_group_assignments_group_id',
      });
    });
    await tryStep('addIndex(useful_link_group_assignments.linkId)', async () => {
      await queryInterface.addIndex('useful_link_group_assignments', ['linkId'], {
        name: 'idx_useful_link_group_assignments_link_id',
      });
    });
  },

  async down(queryInterface, Sequelize) {
    await tryStep('dropTable(useful_link_group_assignments)', async () => {
      if (!(await tableExists(queryInterface, 'useful_link_group_assignments'))) return;
      await queryInterface.dropTable('useful_link_group_assignments');
    });
    await tryStep('dropTable(useful_link_groups)', async () => {
      if (!(await tableExists(queryInterface, 'useful_link_groups'))) return;
      await queryInterface.dropTable('useful_link_groups');
    });
    await tryStep('addColumn(useful_links.isPublished)', async () => {
      if (await columnExists(queryInterface, 'useful_links', 'isPublished')) return;
      await queryInterface.addColumn('useful_links', 'isPublished', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      });
    });
    await tryStep('addColumn(useful_links.isCatalog)', async () => {
      if (await columnExists(queryInterface, 'useful_links', 'isCatalog')) return;
      await queryInterface.addColumn('useful_links', 'isCatalog', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      });
    });
    await tryStep('addColumn(useful_links.ownerId)', async () => {
      if (await columnExists(queryInterface, 'useful_links', 'ownerId')) return;
      await queryInterface.addColumn('useful_links', 'ownerId', {
        type: Sequelize.UUID,
        allowNull: true,
      });
    });
  },
};
