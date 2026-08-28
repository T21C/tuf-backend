'use strict';

const MIGRATION = '1787850002_useful_link_clusters';

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

function generateLinkCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'useful_links'))) {
      return;
    }

    await tryStep('addColumn(useful_links.ownerId)', async () => {
      if (await columnExists(queryInterface, 'useful_links', 'ownerId')) return;
      await queryInterface.addColumn('useful_links', 'ownerId', {
        type: Sequelize.UUID,
        allowNull: true,
      });
    });

    await tryStep('addIndex(useful_links.ownerId)', async () => {
      await queryInterface.addIndex('useful_links', ['ownerId'], {
        name: 'idx_useful_links_owner_id',
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

    await tryStep('addIndex(useful_links.isCatalog)', async () => {
      await queryInterface.addIndex('useful_links', ['isCatalog'], {
        name: 'idx_useful_links_is_catalog',
      });
    });

    await tryStep('createTable(useful_link_clusters)', async () => {
      await queryInterface.createTable('useful_link_clusters', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true,
          allowNull: false,
        },
        ownerId: {
          type: Sequelize.UUID,
          allowNull: false,
        },
        name: {
          type: Sequelize.STRING(255),
          allowNull: false,
        },
        description: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        iconUrl: {
          type: Sequelize.STRING(512),
          allowNull: true,
        },
        viewMode: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 3,
        },
        linkCode: {
          type: Sequelize.STRING(16),
          allowNull: false,
          unique: true,
        },
        isPinned: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        isOfficial: {
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

    await tryStep('addIndex(useful_link_clusters.ownerId)', async () => {
      await queryInterface.addIndex('useful_link_clusters', ['ownerId'], {
        name: 'idx_useful_link_clusters_owner_id',
      });
    });

    await tryStep('createTable(useful_link_cluster_items)', async () => {
      await queryInterface.createTable('useful_link_cluster_items', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true,
          allowNull: false,
        },
        clusterId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'useful_link_clusters',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        linkId: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: {
            model: 'useful_links',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
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

    await tryStep('add unique cluster item index', async () => {
      await queryInterface.addIndex('useful_link_cluster_items', ['clusterId', 'linkId'], {
        unique: true,
        name: 'useful_link_cluster_items_unique',
      });
    });

    await tryStep('createTable(useful_link_cluster_locale_defaults)', async () => {
      await queryInterface.createTable('useful_link_cluster_locale_defaults', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true,
          allowNull: false,
        },
        clusterId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'useful_link_clusters',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        languageCode: {
          type: Sequelize.STRING(8),
          allowNull: false,
        },
        itemId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'useful_link_cluster_items',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
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

    await tryStep('add unique locale default index', async () => {
      await queryInterface.addIndex(
        'useful_link_cluster_locale_defaults',
        ['clusterId', 'languageCode'],
        {
          unique: true,
          name: 'useful_link_cluster_locale_defaults_unique',
        },
      );
    });

    let ownerId = null;
    try {
      const [superAdmins] = await queryInterface.sequelize.query(`
        SELECT id FROM users
        WHERE isSuperAdmin = 1
        ORDER BY createdAt ASC
        LIMIT 1
      `);
      ownerId = superAdmins?.[0]?.id;
    } catch (error) {
      console.log(`[${MIGRATION}] skip official cluster seed: ${error.message}`);
      return;
    }
    if (!ownerId) {
      console.log(`[${MIGRATION}] skip official cluster seed: no super-admin user`);
      return;
    }

    const [existingOfficial] = await queryInterface.sequelize.query(`
      SELECT id FROM useful_link_clusters WHERE isOfficial = 1 LIMIT 1
    `);
    if (existingOfficial && existingOfficial.length) {
      return;
    }

    const now = new Date();
    let linkCode = generateLinkCode();
    for (let attempt = 0; attempt < 20; attempt++) {
      const [collision] = await queryInterface.sequelize.query(
        'SELECT id FROM useful_link_clusters WHERE linkCode = :linkCode LIMIT 1',
        {replacements: {linkCode}},
      );
      if (!collision || !collision.length) break;
      linkCode = generateLinkCode();
    }

    await tryStep('seed official TUF Resources cluster', async () => {
      await queryInterface.bulkInsert('useful_link_clusters', [
        {
          ownerId,
          name: 'TUF Resources',
          description: 'Guides, docs, and Notion pages collected by the TUF team.',
          iconUrl: null,
          viewMode: 1,
          linkCode,
          isPinned: true,
          isOfficial: true,
          createdAt: now,
          updatedAt: now,
        },
      ]);
    });

    const [clusterRows] = await queryInterface.sequelize.query(
      'SELECT id FROM useful_link_clusters WHERE linkCode = :linkCode LIMIT 1',
      {replacements: {linkCode}},
    );
    const clusterId = clusterRows?.[0]?.id;
    if (!clusterId) return;

    await tryStep('attach catalog links to official cluster', async () => {
      await queryInterface.sequelize.query(
        `
        INSERT INTO useful_link_cluster_items (clusterId, linkId, sortOrder, createdAt, updatedAt)
        SELECT :clusterId, ul.id, ul.sortWeight, NOW(), NOW()
        FROM useful_links ul
        WHERE ul.isCatalog = 1
          AND ul.isPublished = 1
          AND ul.id NOT IN (
            SELECT linkId FROM useful_link_cluster_items
            WHERE clusterId = :clusterId AND linkId IS NOT NULL
          )
        ORDER BY ul.sortWeight ASC, ul.id ASC
      `,
        {replacements: {clusterId}},
      );
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'useful_link_cluster_locale_defaults')) {
      await queryInterface.dropTable('useful_link_cluster_locale_defaults');
    }
    if (await tableExists(queryInterface, 'useful_link_cluster_items')) {
      await queryInterface.dropTable('useful_link_cluster_items');
    }
    if (await tableExists(queryInterface, 'useful_link_clusters')) {
      await queryInterface.dropTable('useful_link_clusters');
    }
    if (await tableExists(queryInterface, 'useful_links')) {
      await tryStep('removeIndex ownerId', async () => {
        await queryInterface.removeIndex('useful_links', 'idx_useful_links_owner_id');
      });
      await tryStep('removeIndex isCatalog', async () => {
        await queryInterface.removeIndex('useful_links', 'idx_useful_links_is_catalog');
      });
      if (await columnExists(queryInterface, 'useful_links', 'ownerId')) {
        await queryInterface.removeColumn('useful_links', 'ownerId');
      }
      if (await columnExists(queryInterface, 'useful_links', 'isCatalog')) {
        await queryInterface.removeColumn('useful_links', 'isCatalog');
      }
    }
  },
};
