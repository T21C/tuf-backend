'use strict';

const MIGRATION = '1787850000_useful_link_tags';
const CATEGORY_GROUP = 'Category';
const DEFAULT_TAG_COLORS = [
  '#FF5733',
  '#6C63FF',
  '#2ECC71',
  '#3498DB',
  '#F1C40F',
  '#E67E22',
  '#9B59B6',
  '#1ABC9C',
];

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
    const now = new Date();

    await tryStep('createTable(useful_link_tag_groups)', async () => {
      await queryInterface.createTable('useful_link_tag_groups', {
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

    await tryStep('addIndex(useful_link_tag_groups.sortOrder)', async () => {
      await queryInterface.addIndex('useful_link_tag_groups', ['sortOrder'], {
        name: 'idx_useful_link_tag_groups_sort_order',
      });
    });

    await tryStep('createTable(useful_link_tags)', async () => {
      await queryInterface.createTable('useful_link_tags', {
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
        color: {
          type: Sequelize.STRING(7),
          allowNull: false,
        },
        groupId: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: {
            model: 'useful_link_tag_groups',
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

    await tryStep('addIndex(useful_link_tags.groupId)', async () => {
      await queryInterface.addIndex('useful_link_tags', ['groupId'], {
        name: 'idx_useful_link_tags_group_id',
      });
    });

    await tryStep('createTable(useful_link_tag_assignments)', async () => {
      await queryInterface.createTable('useful_link_tag_assignments', {
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
        tagId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'useful_link_tags',
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

    await tryStep('addIndex(useful_link_tag_assignments unique)', async () => {
      await queryInterface.addIndex('useful_link_tag_assignments', ['linkId', 'tagId'], {
        unique: true,
        name: 'useful_link_tag_assignments_unique',
      });
    });

    const hasLinks = await tableExists(queryInterface, 'useful_links');
    const hasOldGroups = await tableExists(queryInterface, 'useful_link_groups');
    const hasGroupId = hasLinks && (await columnExists(queryInterface, 'useful_links', 'groupId'));

    if (hasLinks && hasOldGroups && hasGroupId) {
      await tryStep('backfill Category tag group', async () => {
        const [existing] = await queryInterface.sequelize.query(
          'SELECT id FROM useful_link_tag_groups WHERE name = :name LIMIT 1',
          {replacements: {name: CATEGORY_GROUP}},
        );
        if (existing && existing.length) return;
        await queryInterface.bulkInsert('useful_link_tag_groups', [
          {
            name: CATEGORY_GROUP,
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
          },
        ]);
      });

      const [categoryRows] = await queryInterface.sequelize.query(
        'SELECT id FROM useful_link_tag_groups WHERE name = :name LIMIT 1',
        {replacements: {name: CATEGORY_GROUP}},
      );
      const categoryGroupId = categoryRows?.[0]?.id ?? null;

      const [oldGroups] = await queryInterface.sequelize.query(`
        SELECT id, name, sortOrder
        FROM useful_link_groups
        ORDER BY sortOrder ASC, name ASC
      `);

      for (let i = 0; i < (oldGroups || []).length; i++) {
        const group = oldGroups[i];
        const name = String(group.name || '').trim();
        if (!name) continue;
        await tryStep(`backfill tag "${name}"`, async () => {
          const [existingTag] = await queryInterface.sequelize.query(
            'SELECT id FROM useful_link_tags WHERE name = :name LIMIT 1',
            {replacements: {name}},
          );
          if (existingTag && existingTag.length) return;
          await queryInterface.bulkInsert('useful_link_tags', [
            {
              name,
              color: DEFAULT_TAG_COLORS[i % DEFAULT_TAG_COLORS.length],
              groupId: categoryGroupId,
              sortOrder: Number.isInteger(group.sortOrder) ? group.sortOrder : i,
              createdAt: now,
              updatedAt: now,
            },
          ]);
        });
      }

      await tryStep('backfill tag assignments from useful_links.groupId', async () => {
        const [linkGroups] = await queryInterface.sequelize.query(`
          SELECT ul.id AS linkId, g.name AS groupName
          FROM useful_links ul
          INNER JOIN useful_link_groups g ON ul.groupId = g.id
          WHERE ul.groupId IS NOT NULL
        `);
        const [tags] = await queryInterface.sequelize.query(
          'SELECT id, name FROM useful_link_tags',
        );
        const tagIdByName = new Map(
          (tags || []).map((tag) => [String(tag.name || '').trim().toLowerCase(), tag.id]),
        );
        const rows = [];
        const seen = new Set();
        const [existingAssignments] = await queryInterface.sequelize.query(
          'SELECT linkId, tagId FROM useful_link_tag_assignments',
        );
        for (const row of existingAssignments || []) {
          seen.add(`${row.linkId}:${row.tagId}`);
        }
        for (const row of linkGroups || []) {
          const tagId = tagIdByName.get(String(row.groupName || '').trim().toLowerCase());
          if (!tagId) continue;
          const key = `${row.linkId}:${tagId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({
            linkId: row.linkId,
            tagId,
            createdAt: now,
            updatedAt: now,
          });
        }
        if (rows.length) {
          await queryInterface.bulkInsert('useful_link_tag_assignments', rows);
        }
      });
    }

    if (hasGroupId) {
      await tryStep('drop useful_links.groupId foreign keys', async () => {
        const [fks] = await queryInterface.sequelize.query(`
          SELECT CONSTRAINT_NAME AS name
          FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'useful_links'
            AND COLUMN_NAME = 'groupId'
            AND REFERENCED_TABLE_NAME IS NOT NULL
        `);
        for (const fk of fks || []) {
          if (!fk?.name) continue;
          await queryInterface.removeConstraint('useful_links', fk.name);
        }
      });
      await tryStep('removeIndex(idx_useful_links_group_id)', async () => {
        await queryInterface.removeIndex('useful_links', 'idx_useful_links_group_id');
      });
      await tryStep('removeColumn(useful_links.groupId)', async () => {
        await queryInterface.removeColumn('useful_links', 'groupId');
      });
    }

    if (await tableExists(queryInterface, 'useful_link_groups')) {
      await tryStep('dropTable(useful_link_groups)', async () => {
        await queryInterface.dropTable('useful_link_groups');
      });
    }
  },

  async down(queryInterface, Sequelize) {
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

    if (await tableExists(queryInterface, 'useful_links')) {
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
    }

    if (await tableExists(queryInterface, 'useful_link_tag_assignments')) {
      await queryInterface.dropTable('useful_link_tag_assignments');
    }
    if (await tableExists(queryInterface, 'useful_link_tags')) {
      await queryInterface.dropTable('useful_link_tags');
    }
    if (await tableExists(queryInterface, 'useful_link_tag_groups')) {
      await queryInterface.dropTable('useful_link_tag_groups');
    }
  },
};
