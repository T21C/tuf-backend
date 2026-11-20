'use strict';

/**
 * Collectable badge definitions, state, equip slots, reviews, jobs, and
 * clear-time snapshots. The badges model group shares the players pool.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('badge_definitions')) {
        await queryInterface.createTable(
          'badge_definitions',
          {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            audience: { type: Sequelize.STRING(16), allowNull: false },
            slug: { type: Sequelize.STRING(64), allowNull: false },
            name: { type: Sequelize.STRING(80), allowNull: false },
            secret: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
            reducer: { type: Sequelize.STRING(32), allowNull: false },
            grantMode: { type: Sequelize.STRING(32), allowNull: false },
            identityMode: { type: Sequelize.STRING(32), allowNull: false },
            backfill: { type: Sequelize.STRING(16), allowNull: false },
            curve: { type: Sequelize.JSON, allowNull: false },
            tierLabels: { type: Sequelize.JSON, allowNull: false },
            weight: { type: Sequelize.DOUBLE, allowNull: false, defaultValue: 1 },
            display: { type: Sequelize.JSON, allowNull: false },
            confirmMode: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'none' },
            params: { type: Sequelize.JSON, allowNull: false },
            publishedAt: { type: Sequelize.DATE, allowNull: true },
            createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
          },
          { transaction },
        );
        await queryInterface.addIndex('badge_definitions', ['slug'], {
          unique: true,
          name: 'badge_definitions_slug_unique',
          transaction,
        });
        await queryInterface.addIndex('badge_definitions', ['audience', 'enabled'], {
          name: 'badge_definitions_audience_enabled',
          transaction,
        });
      }

      if (!names.includes('badge_sets')) {
        await queryInterface.createTable(
          'badge_sets',
          {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            name: { type: Sequelize.STRING(64), allowNull: false },
            kind: { type: Sequelize.STRING(16), allowNull: false },
            values: { type: Sequelize.JSON, allowNull: false },
            createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
          },
          { transaction },
        );
        await queryInterface.addIndex('badge_sets', ['name'], {
          unique: true,
          name: 'badge_sets_name_unique',
          transaction,
        });
      }

      if (!names.includes('pass_badge_snapshots')) {
        await queryInterface.createTable(
          'pass_badge_snapshots',
          {
            passId: {
              type: Sequelize.INTEGER,
              primaryKey: true,
              allowNull: false,
              references: { model: 'passes', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            diffId: { type: Sequelize.INTEGER, allowNull: true },
            baseScore: { type: Sequelize.DOUBLE, allowNull: true },
            ppBaseScore: { type: Sequelize.DOUBLE, allowNull: true },
            curationTypeIds: { type: Sequelize.JSON, allowNull: false },
            charterIds: { type: Sequelize.JSON, allowNull: false },
            vfxerIds: { type: Sequelize.JSON, allowNull: false },
            createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
          },
          { transaction },
        );
      }

      if (!names.includes('badge_states')) {
        await queryInterface.createTable(
          'badge_states',
          {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            ownerType: { type: Sequelize.STRING(16), allowNull: false },
            ownerId: { type: Sequelize.INTEGER, allowNull: false },
            definitionId: {
              type: Sequelize.INTEGER,
              allowNull: false,
              references: { model: 'badge_definitions', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            tier: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            credit: { type: Sequelize.DOUBLE, allowNull: false, defaultValue: 0 },
            barFrom: { type: Sequelize.DOUBLE, allowNull: false, defaultValue: 0 },
            barTo: { type: Sequelize.DOUBLE, allowNull: false, defaultValue: 0 },
            barValue: { type: Sequelize.DOUBLE, allowNull: false, defaultValue: 0 },
            provingPassIds: { type: Sequelize.JSON, allowNull: false },
            earnedAt: { type: Sequelize.DATE, allowNull: true },
            tierLabel: { type: Sequelize.STRING(40), allowNull: true },
            snapshotIds: { type: Sequelize.JSON, allowNull: true },
            createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
          },
          { transaction },
        );
        await queryInterface.addIndex('badge_states', ['ownerType', 'ownerId', 'definitionId'], {
          unique: true,
          name: 'badge_states_owner_definition_unique',
          transaction,
        });
        await queryInterface.addIndex('badge_states', ['definitionId'], {
          name: 'badge_states_definition',
          transaction,
        });
      }

      if (!names.includes('badge_equips')) {
        await queryInterface.createTable(
          'badge_equips',
          {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            ownerType: { type: Sequelize.STRING(16), allowNull: false },
            ownerId: { type: Sequelize.INTEGER, allowNull: false },
            slot: { type: Sequelize.TINYINT, allowNull: false },
            definitionId: {
              type: Sequelize.INTEGER,
              allowNull: false,
              references: { model: 'badge_definitions', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
          },
          { transaction },
        );
        await queryInterface.addIndex('badge_equips', ['ownerType', 'ownerId', 'slot'], {
          unique: true,
          name: 'badge_equips_owner_slot_unique',
          transaction,
        });
      }

      if (!names.includes('badge_reviews')) {
        await queryInterface.createTable(
          'badge_reviews',
          {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            definitionId: {
              type: Sequelize.INTEGER,
              allowNull: false,
              references: { model: 'badge_definitions', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            passId: {
              type: Sequelize.INTEGER,
              allowNull: false,
              references: { model: 'passes', key: 'id' },
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            videoUrl: { type: Sequelize.TEXT, allowNull: false },
            status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'pending' },
            reviewerId: { type: Sequelize.UUID, allowNull: true },
            reviewedAt: { type: Sequelize.DATE, allowNull: true },
            createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
          },
          { transaction },
        );
        await queryInterface.addIndex('badge_reviews', ['definitionId', 'passId'], {
          unique: true,
          name: 'badge_reviews_definition_pass_unique',
          transaction,
        });
        await queryInterface.addIndex('badge_reviews', ['status'], {
          name: 'badge_reviews_status',
          transaction,
        });
      }

      if (!names.includes('badge_jobs')) {
        await queryInterface.createTable(
          'badge_jobs',
          {
            id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
            scope: { type: Sequelize.STRING(16), allowNull: false },
            definitionId: { type: Sequelize.INTEGER, allowNull: true },
            playerId: { type: Sequelize.INTEGER, allowNull: true },
            creatorId: { type: Sequelize.INTEGER, allowNull: true },
            levelId: { type: Sequelize.INTEGER, allowNull: true },
            packId: { type: Sequelize.INTEGER, allowNull: true },
            replaceState: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
            status: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'pending' },
            skipPlaceholder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            skipUnknownTime: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            skipMissingDifficulty: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
            summary: { type: Sequelize.TEXT, allowNull: true },
            error: { type: Sequelize.TEXT, allowNull: true },
            createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
            startedAt: { type: Sequelize.DATE, allowNull: true },
            finishedAt: { type: Sequelize.DATE, allowNull: true },
          },
          { transaction },
        );
        await queryInterface.addIndex('badge_jobs', ['status', 'id'], {
          name: 'badge_jobs_status_id',
          transaction,
        });
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      for (const table of [
        'badge_jobs',
        'badge_reviews',
        'badge_equips',
        'badge_states',
        'pass_badge_snapshots',
        'badge_sets',
        'badge_definitions',
      ]) {
        await queryInterface.dropTable(table, { transaction });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
