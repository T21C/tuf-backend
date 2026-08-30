'use strict';

const MIGRATION = '1788008000_mods_catalog_v2';
const SLUG_MAX = 80;
const RESERVED = new Set(['tags', 'edit', 'download', 'like', 'isliked']);

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

function uniqueWithNumericSuffix(desired, used) {
  const base = String(desired || '').trim() || 'mod';
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function slugifyToken(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX);
}

function slugifyName(name) {
  const parts = String(name || '')
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  if (!parts || parts.length === 0) return '';
  return parts.join('-').slice(0, SLUG_MAX);
}

function githubRepoSlugFromUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
    const parts = path.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    if (host !== 'github.com' && host !== 'www.github.com' && !host.endsWith('.githubusercontent.com')) {
      return null;
    }
    const slug = slugifyToken(parts[1].replace(/\.git$/i, ''));
    return slug || null;
  } catch {
    return null;
  }
}

function preferredSlug(row, fallbackIndex) {
  const fromProject = row.projectUrl ? githubRepoSlugFromUrl(row.projectUrl) : null;
  if (fromProject) return fromProject;
  const fromDownload = row.downloadUrl ? githubRepoSlugFromUrl(row.downloadUrl) : null;
  if (fromDownload) return fromDownload;
  const fromName = slugifyName(row.name);
  if (fromName) return fromName;
  return String(fallbackIndex);
}

function allocateSlug(row, fallbackIndex, taken) {
  const used = new Set(taken);
  for (const reserved of RESERVED) used.add(reserved);
  return uniqueWithNumericSuffix(preferredSlug(row, fallbackIndex), used);
}

function versionLabel(raw) {
  const trimmed = String(raw || '').trim();
  return trimmed ? trimmed.slice(0, 64) : 'unspecified';
}

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await tryStep('addColumn(mods.slug)', async () => {
      await queryInterface.addColumn('mods', 'slug', {
        type: Sequelize.STRING(80),
        allowNull: true,
      });
    });
    await tryStep('addColumn(mods.isPinned)', async () => {
      await queryInterface.addColumn('mods', 'isPinned', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      });
    });
    await tryStep('addColumn(mods.likes)', async () => {
      await queryInterface.addColumn('mods', 'likes', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
    });
    await tryStep('addColumn(mods.downloadCount)', async () => {
      await queryInterface.addColumn('mods', 'downloadCount', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      });
    });
    await tryStep('addIndex(mods.isPinned)', async () => {
      await queryInterface.addIndex('mods', ['isPinned'], {name: 'idx_mods_is_pinned'});
    });

    await tryStep('createTable(mod_versions)', async () => {
      if (await tableExists(queryInterface, 'mod_versions')) return;
      await queryInterface.createTable('mod_versions', {
        id: {type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false},
        modId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {model: 'mods', key: 'id'},
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        version: {type: Sequelize.STRING(64), allowNull: false},
        downloadUrl: {type: Sequelize.TEXT, allowNull: false},
        notes: {type: Sequelize.TEXT, allowNull: true},
        releasedAt: {type: Sequelize.DATE, allowNull: false},
        createdAt: {type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')},
        updatedAt: {type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')},
      });
    });
    await tryStep('addIndex(mod_versions unique)', async () => {
      await queryInterface.addIndex('mod_versions', ['modId', 'version'], {
        unique: true,
        name: 'mod_versions_mod_version_unique',
      });
    });
    await tryStep('addIndex(mod_versions released)', async () => {
      await queryInterface.addIndex('mod_versions', ['modId', 'releasedAt'], {
        name: 'idx_mod_versions_mod_released',
      });
    });

    await tryStep('createTable(mod_tags)', async () => {
      if (await tableExists(queryInterface, 'mod_tags')) return;
      await queryInterface.createTable('mod_tags', {
        id: {type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false},
        name: {type: Sequelize.STRING(64), allowNull: false, unique: true},
        color: {type: Sequelize.STRING(7), allowNull: false, defaultValue: '#8d70ff'},
        sortOrder: {type: Sequelize.INTEGER, allowNull: false, defaultValue: 0},
        createdAt: {type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')},
        updatedAt: {type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')},
      });
    });

    await tryStep('createTable(mod_tag_assignments)', async () => {
      if (await tableExists(queryInterface, 'mod_tag_assignments')) return;
      await queryInterface.createTable('mod_tag_assignments', {
        id: {type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false},
        modId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {model: 'mods', key: 'id'},
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        tagId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {model: 'mod_tags', key: 'id'},
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        createdAt: {type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')},
        updatedAt: {type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')},
      });
    });
    await tryStep('addIndex(mod_tag_assignments unique)', async () => {
      await queryInterface.addIndex('mod_tag_assignments', ['modId', 'tagId'], {
        unique: true,
        name: 'mod_tag_assignments_unique',
      });
    });
    await tryStep('addIndex(mod_tag_assignments.tagId)', async () => {
      await queryInterface.addIndex('mod_tag_assignments', ['tagId'], {name: 'idx_mod_tag_assignments_tag_id'});
    });

    await tryStep('createTable(mod_likes)', async () => {
      if (await tableExists(queryInterface, 'mod_likes')) return;
      await queryInterface.createTable('mod_likes', {
        id: {type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false},
        modId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {model: 'mods', key: 'id'},
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        userId: {type: Sequelize.UUID, allowNull: false},
        createdAt: {type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')},
        updatedAt: {type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')},
      });
    });
    await tryStep('addIndex(mod_likes unique)', async () => {
      await queryInterface.addIndex('mod_likes', ['modId', 'userId'], {
        unique: true,
        name: 'mod_likes_mod_user_unique',
      });
    });
    await tryStep('addIndex(mod_likes.userId)', async () => {
      await queryInterface.addIndex('mod_likes', ['userId'], {name: 'idx_mod_likes_user_id'});
    });

    await tryStep('createTable(mod_download_uniques)', async () => {
      if (await tableExists(queryInterface, 'mod_download_uniques')) return;
      await queryInterface.createTable('mod_download_uniques', {
        id: {type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false},
        modId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {model: 'mods', key: 'id'},
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        ipHash: {type: Sequelize.STRING(64), allowNull: false},
        dayDate: {type: Sequelize.DATEONLY, allowNull: false},
        createdAt: {type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')},
      });
    });
    await tryStep('addIndex(mod_download_uniques unique)', async () => {
      await queryInterface.addIndex('mod_download_uniques', ['modId', 'ipHash', 'dayDate'], {
        unique: true,
        name: 'mod_download_uniques_unique',
      });
    });
    await tryStep('addIndex(mod_download_uniques.dayDate)', async () => {
      await queryInterface.addIndex('mod_download_uniques', ['dayDate'], {name: 'idx_mod_download_uniques_day'});
    });

    await tryStep('createTable(mod_slug_redirects)', async () => {
      if (await tableExists(queryInterface, 'mod_slug_redirects')) return;
      await queryInterface.createTable('mod_slug_redirects', {
        id: {type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false},
        slug: {type: Sequelize.STRING(80), allowNull: false, unique: true},
        modId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {model: 'mods', key: 'id'},
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        createdAt: {type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')},
        updatedAt: {type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')},
      });
    });
    await tryStep('addIndex(mod_slug_redirects.modId)', async () => {
      await queryInterface.addIndex('mod_slug_redirects', ['modId'], {name: 'idx_mod_slug_redirects_mod_id'});
    });

    await tryStep('backfill slugs and initial versions', async () => {
      const [mods] = await queryInterface.sequelize.query(
        'SELECT id, name, version, downloadUrl, projectUrl, sourceUploadedAt FROM mods ORDER BY id ASC',
      );
      const [existingVersions] = await queryInterface.sequelize.query(
        'SELECT modId FROM mod_versions',
      );
      const hasVersion = new Set((existingVersions || []).map((row) => Number(row.modId)));
      const taken = new Set();
      const now = new Date();
      for (let i = 0; i < mods.length; i += 1) {
        const row = mods[i];
        const slug = allocateSlug(row, i + 1, taken);
        taken.add(slug);
        await queryInterface.sequelize.query('UPDATE mods SET slug = :slug WHERE id = :id', {
          replacements: {slug, id: row.id},
        });
        if (!hasVersion.has(Number(row.id))) {
          await queryInterface.bulkInsert('mod_versions', [
            {
              modId: row.id,
              version: versionLabel(row.version),
              downloadUrl: row.downloadUrl,
              notes: null,
              releasedAt: row.sourceUploadedAt || now,
              createdAt: now,
              updatedAt: now,
            },
          ]);
        }
      }
    });

    await tryStep('changeColumn(mods.slug not null)', async () => {
      await queryInterface.changeColumn('mods', 'slug', {
        type: Sequelize.STRING(80),
        allowNull: false,
      });
    });
    await tryStep('addIndex(mods.slug unique)', async () => {
      await queryInterface.addIndex('mods', ['slug'], {unique: true, name: 'mods_slug_unique'});
    });
  },

  async down(queryInterface) {
    await tryStep('dropTable(mod_slug_redirects)', async () => {
      if (await tableExists(queryInterface, 'mod_slug_redirects')) {
        await queryInterface.dropTable('mod_slug_redirects');
      }
    });
    await tryStep('dropTable(mod_download_uniques)', async () => {
      if (await tableExists(queryInterface, 'mod_download_uniques')) {
        await queryInterface.dropTable('mod_download_uniques');
      }
    });
    await tryStep('dropTable(mod_likes)', async () => {
      if (await tableExists(queryInterface, 'mod_likes')) {
        await queryInterface.dropTable('mod_likes');
      }
    });
    await tryStep('dropTable(mod_tag_assignments)', async () => {
      if (await tableExists(queryInterface, 'mod_tag_assignments')) {
        await queryInterface.dropTable('mod_tag_assignments');
      }
    });
    await tryStep('dropTable(mod_tags)', async () => {
      if (await tableExists(queryInterface, 'mod_tags')) {
        await queryInterface.dropTable('mod_tags');
      }
    });
    await tryStep('dropTable(mod_versions)', async () => {
      if (await tableExists(queryInterface, 'mod_versions')) {
        await queryInterface.dropTable('mod_versions');
      }
    });
    await tryStep('removeIndex(mods.slug)', async () => {
      await queryInterface.removeIndex('mods', 'mods_slug_unique');
    });
    await tryStep('removeIndex(mods.isPinned)', async () => {
      await queryInterface.removeIndex('mods', 'idx_mods_is_pinned');
    });
    await tryStep('removeColumn(mods.slug)', async () => {
      await queryInterface.removeColumn('mods', 'slug');
    });
    await tryStep('removeColumn(mods.isPinned)', async () => {
      await queryInterface.removeColumn('mods', 'isPinned');
    });
    await tryStep('removeColumn(mods.likes)', async () => {
      await queryInterface.removeColumn('mods', 'likes');
    });
    await tryStep('removeColumn(mods.downloadCount)', async () => {
      await queryInterface.removeColumn('mods', 'downloadCount');
    });
  },
};
