'use strict';

const {createHash} = require('node:crypto');

const MIGRATION = '1790433647_bot_mods_name_identity';

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

function timeOf(value) {
  if (!value) return -1;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? -1 : time;
}

/** Must match botModIdFromName in botModIdentity.ts. */
function botModIdFromName(name) {
  return createHash('sha256').update(String(name)).digest('hex');
}

async function rekeyBotModsByName(queryInterface) {
  const [rows] = await queryInterface.sequelize.query(
    'SELECT id, name, uploadedAt, lastSeenAt FROM bot_mods',
  );
  const byName = new Map();
  for (const row of rows) {
    const name = String(row.name ?? '');
    const list = byName.get(name);
    if (list) list.push(row);
    else byName.set(name, [row]);
  }

  const transaction = await queryInterface.sequelize.transaction();
  try {
    for (const [name, entries] of byName) {
      const survivor = entries.reduce((best, row) => {
        const uploaded = timeOf(row.uploadedAt) - timeOf(best.uploadedAt);
        if (uploaded !== 0) return uploaded > 0 ? row : best;
        const seen = timeOf(row.lastSeenAt) - timeOf(best.lastSeenAt);
        if (seen !== 0) return seen > 0 ? row : best;
        return String(row.id) > String(best.id) ? row : best;
      });
      const nextId = botModIdFromName(name);
      const ids = entries.map((row) => String(row.id));
      const [links] = await queryInterface.sequelize.query(
        'SELECT id, botId FROM bot_mod_links WHERE botId IN (:ids)',
        {replacements: {ids}, transaction},
      );
      const keep = links.find((link) => String(link.botId) === String(survivor.id)) || links[0] || null;
      for (const link of links) {
        if (!keep || String(link.id) === String(keep.id)) continue;
        await queryInterface.sequelize.query('DELETE FROM bot_mod_links WHERE id = :id', {
          replacements: {id: link.id},
          transaction,
        });
      }
      if (keep && String(keep.botId) !== String(survivor.id)) {
        await queryInterface.sequelize.query(
          'UPDATE bot_mod_links SET botId = :botId WHERE id = :id',
          {replacements: {botId: survivor.id, id: keep.id}, transaction},
        );
      }
      for (const row of entries) {
        if (String(row.id) === String(survivor.id)) continue;
        await queryInterface.sequelize.query('DELETE FROM bot_mods WHERE id = :id', {
          replacements: {id: row.id},
          transaction,
        });
      }
      if (String(survivor.id) !== nextId) {
        await queryInterface.sequelize.query('UPDATE bot_mods SET id = :nextId WHERE id = :id', {
          replacements: {nextId, id: survivor.id},
          transaction,
        });
      }
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await tryStep('createTable(bot_mod_releases)', async () => {
      if (await tableExists(queryInterface, 'bot_mod_releases')) return;
      await queryInterface.createTable('bot_mod_releases', {
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
        version: {
          type: Sequelize.STRING(64),
          allowNull: false,
        },
        parsedDownload: {
          type: Sequelize.TEXT,
          allowNull: false,
        },
        download: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        description: {
          type: Sequelize.TEXT,
          allowNull: true,
        },
        uploadedAt: {
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

    await tryStep('addIndex(bot_mod_releases.botId, version unique)', async () => {
      await queryInterface.addIndex('bot_mod_releases', ['botId', 'version'], {
        unique: true,
        name: 'bot_mod_releases_bot_version_unique',
      });
    });

    if (await tableExists(queryInterface, 'bot_mods')) {
      await rekeyBotModsByName(queryInterface);
    }

    await tryStep('addIndex(bot_mods.name unique)', async () => {
      await queryInterface.addIndex('bot_mods', ['name'], {
        unique: true,
        name: 'bot_mods_name_unique',
      });
    });
  },

  async down(queryInterface) {
    await tryStep('removeIndex(bot_mods.name unique)', async () => {
      await queryInterface.removeIndex('bot_mods', 'bot_mods_name_unique');
    });
    await tryStep('dropTable(bot_mod_releases)', async () => {
      if (!(await tableExists(queryInterface, 'bot_mod_releases'))) return;
      await queryInterface.dropTable('bot_mod_releases');
    });
  },
};
