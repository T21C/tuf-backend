'use strict';

const MIGRATION = '1787600000_normalize_level_tag_groups';

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

async function getLevelTagsGroupCollation(queryInterface) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT CHARACTER_SET_NAME, COLLATION_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'level_tags'
       AND COLUMN_NAME IN ('group', 'name')
     ORDER BY CASE COLUMN_NAME WHEN 'group' THEN 0 ELSE 1 END
     LIMIT 1`,
  );
  const col = rows?.[0];
  const charset = String(col?.CHARACTER_SET_NAME || 'utf8mb4');
  const collation = String(col?.COLLATION_NAME || 'utf8mb4_unicode_ci');
  if (!/^[A-Za-z0-9_]+$/.test(charset) || !/^[A-Za-z0-9_]+$/.test(collation)) {
    throw new Error(
      `Unexpected charset/collation for level_tags.group: ${charset} / ${collation}`,
    );
  }
  return { charset, collation };
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const { charset, collation } = await getLevelTagsGroupCollation(queryInterface);

    await tryStep('createTable(level_tag_groups)', async () => {
      await queryInterface.createTable('level_tag_groups', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true,
          allowNull: false,
        },
        name: {
          type: Sequelize.STRING,
          allowNull: false,
          unique: true,
          charset,
          collate: collation,
        },
        sortOrder: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
          comment: 'Sort order for tag groups display',
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
        },
      });
    });

    await tryStep('addIndex(level_tag_groups.sortOrder)', async () => {
      await queryInterface.addIndex('level_tag_groups', ['sortOrder'], {
        name: 'idx_level_tag_groups_sort_order',
      });
    });

    if (await columnExists(queryInterface, 'level_tags', 'group')) {
      await tryStep('backfill level_tag_groups from level_tags.group', async () => {
        await queryInterface.sequelize.query(`
          INSERT IGNORE INTO level_tag_groups (name, sortOrder, createdAt, updatedAt)
          SELECT TRIM(\`group\`) AS name,
                 MIN(groupSortOrder) AS sortOrder,
                 CURRENT_TIMESTAMP,
                 CURRENT_TIMESTAMP
          FROM level_tags
          WHERE \`group\` IS NOT NULL AND CHAR_LENGTH(TRIM(\`group\`)) > 0
          GROUP BY TRIM(\`group\`)
        `);
      });
    }

    await tryStep('re-rank level_tag_groups.sortOrder', async () => {
      await queryInterface.sequelize.query(`
        UPDATE level_tag_groups g
        JOIN (
          SELECT id, ROW_NUMBER() OVER (ORDER BY sortOrder ASC, name ASC) - 1 AS new_order
          FROM level_tag_groups
        ) ranked ON g.id = ranked.id
        SET g.sortOrder = ranked.new_order
      `);
    });

    await tryStep('addColumn(level_tags.groupId)', async () => {
      await queryInterface.addColumn('level_tags', 'groupId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'level_tag_groups',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
    });

    await tryStep('addIndex(level_tags.groupId)', async () => {
      await queryInterface.addIndex('level_tags', ['groupId'], {
        name: 'idx_level_tags_group_id',
      });
    });

    const hasGroup = await columnExists(queryInterface, 'level_tags', 'group');
    const hasGroupId = await columnExists(queryInterface, 'level_tags', 'groupId');

    if (hasGroup && hasGroupId) {
      await tryStep('link level_tags.groupId from group names', async () => {
        await queryInterface.sequelize.query(`
          UPDATE level_tags lt
          INNER JOIN level_tag_groups g
            ON TRIM(lt.\`group\`) COLLATE ${collation} = g.name COLLATE ${collation}
          SET lt.groupId = g.id
          WHERE lt.\`group\` IS NOT NULL AND CHAR_LENGTH(TRIM(lt.\`group\`)) > 0
        `);
      });

      const [unlinked] = await queryInterface.sequelize.query(`
        SELECT COUNT(*) AS cnt
        FROM level_tags
        WHERE \`group\` IS NOT NULL AND CHAR_LENGTH(TRIM(\`group\`)) > 0 AND groupId IS NULL
      `);
      const unlinkedCount = Number(unlinked?.[0]?.cnt ?? 0);
      if (unlinkedCount > 0) {
        throw new Error(
          `Failed to link ${unlinkedCount} level_tags row(s) with a named group to level_tag_groups`,
        );
      }
    }

    await tryStep('removeIndex(idx_level_tags_group_sort_order)', async () => {
      await queryInterface.removeIndex('level_tags', 'idx_level_tags_group_sort_order');
    });
    await tryStep('removeColumn(level_tags.group)', async () => {
      await queryInterface.removeColumn('level_tags', 'group');
    });
    await tryStep('removeColumn(level_tags.groupSortOrder)', async () => {
      await queryInterface.removeColumn('level_tags', 'groupSortOrder');
    });
  },

  async down(queryInterface, Sequelize) {
    let charset = 'utf8mb4';
    let collation = 'utf8mb4_unicode_ci';
    await tryStep('read level_tag_groups.name collation', async () => {
      const [groupRows] = await queryInterface.sequelize.query(
        `SELECT CHARACTER_SET_NAME, COLLATION_NAME
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'level_tag_groups'
           AND COLUMN_NAME = 'name'`,
      );
      const groupCol = groupRows?.[0];
      if (groupCol?.CHARACTER_SET_NAME) charset = String(groupCol.CHARACTER_SET_NAME);
      if (groupCol?.COLLATION_NAME) collation = String(groupCol.COLLATION_NAME);
    });

    await tryStep('addColumn(level_tags.group)', async () => {
      await queryInterface.addColumn('level_tags', 'group', {
        type: Sequelize.STRING,
        allowNull: true,
        charset,
        collate: collation,
        comment: 'Optional group name for organizing tags',
      });
    });

    await tryStep('addColumn(level_tags.groupSortOrder)', async () => {
      await queryInterface.addColumn('level_tags', 'groupSortOrder', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Sort order for tag groups display',
      });
    });

    if (
      (await tableExists(queryInterface, 'level_tag_groups')) &&
      (await columnExists(queryInterface, 'level_tags', 'group')) &&
      (await columnExists(queryInterface, 'level_tags', 'groupId'))
    ) {
      await tryStep('copy group names back onto level_tags', async () => {
        await queryInterface.sequelize.query(`
          UPDATE level_tags lt
          LEFT JOIN level_tag_groups g ON lt.groupId = g.id
          SET lt.\`group\` = g.name,
              lt.groupSortOrder = COALESCE(g.sortOrder, 0)
        `);
      });
    }

    await tryStep('addIndex(idx_level_tags_group_sort_order)', async () => {
      await queryInterface.addIndex('level_tags', ['groupSortOrder'], {
        name: 'idx_level_tags_group_sort_order',
      });
    });
    await tryStep('removeIndex(idx_level_tags_group_id)', async () => {
      await queryInterface.removeIndex('level_tags', 'idx_level_tags_group_id');
    });
    await tryStep('removeColumn(level_tags.groupId)', async () => {
      await queryInterface.removeColumn('level_tags', 'groupId');
    });
    await tryStep('removeIndex(idx_level_tag_groups_sort_order)', async () => {
      await queryInterface.removeIndex('level_tag_groups', 'idx_level_tag_groups_sort_order');
    });
    await tryStep('dropTable(level_tag_groups)', async () => {
      await queryInterface.dropTable('level_tag_groups');
    });
  },
};
