'use strict';

const MIGRATION = '1790160967_bot_mods';

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
    await tryStep('createTable(bot_mods)', async () => {
      if (await tableExists(queryInterface, 'bot_mods')) return;
      await queryInterface.createTable('bot_mods', {
        id: {
          type: Sequelize.STRING(64),
          primaryKey: true,
          allowNull: false,
        },
        sourceMongoId: {
          type: Sequelize.STRING(32),
          allowNull: true,
        },
        name: {
          type: Sequelize.STRING(512),
          allowNull: false,
        },
        version: {
          type: Sequelize.STRING(64),
          allowNull: true,
        },
        parsedDownload: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        download: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        description: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        cachedUsername: {
          type: Sequelize.STRING(64),
          allowNull: false,
        },
        creatorDiscordId: {
          type: Sequelize.STRING(32),
          allowNull: false,
        },
        uploadedAt: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        ignoreUpdate: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        hideFromSearch: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        lastSeenAt: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        missingSince: {
          type: Sequelize.DATE,
          allowNull: true,
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

    await tryStep('addIndex(bot_mods.missingSince)', async () => {
      await queryInterface.addIndex('bot_mods', ['missingSince'], {
        name: 'idx_bot_mods_missing_since',
      });
    });

    await tryStep('createTable(bot_mod_links)', async () => {
      if (await tableExists(queryInterface, 'bot_mod_links')) return;
      await queryInterface.createTable('bot_mod_links', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true,
          allowNull: false,
        },
        botId: {
          type: Sequelize.STRING(64),
          allowNull: false,
          references: {model: 'bot_mods', key: 'id'},
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        modId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {model: 'mods', key: 'id'},
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        enabled: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        lastAppliedVersion: {
          type: Sequelize.STRING(64),
          allowNull: true,
        },
        lastAppliedDownloadUrl: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        lastSyncAt: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        lastSyncStatus: {
          type: Sequelize.STRING(32),
          allowNull: true,
        },
        lastSyncMessage: {
          type: Sequelize.TEXT,
          allowNull: true,
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

    await tryStep('addIndex(bot_mod_links.botId unique)', async () => {
      await queryInterface.addIndex('bot_mod_links', ['botId'], {
        unique: true,
        name: 'bot_mod_links_bot_id_unique',
      });
    });

    await tryStep('addIndex(bot_mod_links.modId unique)', async () => {
      await queryInterface.addIndex('bot_mod_links', ['modId'], {
        unique: true,
        name: 'bot_mod_links_mod_id_unique',
      });
    });
  },

  async down(queryInterface) {
    await tryStep('dropTable(bot_mod_links)', async () => {
      if (!(await tableExists(queryInterface, 'bot_mod_links'))) return;
      await queryInterface.dropTable('bot_mod_links');
    });
    await tryStep('dropTable(bot_mods)', async () => {
      if (!(await tableExists(queryInterface, 'bot_mods'))) return;
      await queryInterface.dropTable('bot_mods');
    });
  },
};
