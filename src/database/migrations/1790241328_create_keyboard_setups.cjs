'use strict';

const seed = require('../data/keyboard-catalog-seed.json');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable(
        'keyboard_geometries',
        {
          id: {type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true},
          slug: {type: Sequelize.STRING(64), allowNull: false, unique: true},
          name: {type: Sequelize.STRING(120), allowNull: false},
          formFactor: {
            type: Sequelize.ENUM('full', 'tkl', '96', '75', '65', 'other'),
            allowNull: false,
          },
          keysJson: {type: Sequelize.JSON, allowNull: false},
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
        },
        {transaction},
      );

      await queryInterface.createTable(
        'keyboard_products',
        {
          id: {type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true},
          geometryId: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: {model: 'keyboard_geometries', key: 'id'},
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          brand: {type: Sequelize.STRING(120), allowNull: false},
          model: {type: Sequelize.STRING(120), allowNull: false},
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
        },
        {transaction},
      );
      await queryInterface.addIndex('keyboard_products', ['brand', 'model'], {
        unique: true,
        name: 'uniq_keyboard_products_brand_model',
        transaction,
      });

      await queryInterface.createTable(
        'keyboard_switches',
        {
          id: {type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true},
          name: {type: Sequelize.STRING(120), allowNull: false, unique: true},
          sensing: {
            type: Sequelize.ENUM('mechanical', 'optical', 'hall', 'other'),
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
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
          },
        },
        {transaction},
      );

      await queryInterface.createTable(
        'keyboard_rigs',
        {
          id: {type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true},
          playerId: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: {model: 'players', key: 'id'},
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          name: {type: Sequelize.STRING(80), allowNull: true},
          sortOrder: {type: Sequelize.INTEGER, allowNull: false, defaultValue: 0},
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
        },
        {transaction},
      );
      await queryInterface.addIndex('keyboard_rigs', ['playerId'], {
        name: 'idx_keyboard_rigs_player_id',
        transaction,
      });

      await queryInterface.createTable(
        'keyboard_board_periods',
        {
          id: {type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true},
          rigId: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: {model: 'keyboard_rigs', key: 'id'},
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          sinceDate: {type: Sequelize.DATEONLY, allowNull: true},
          isGap: {type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false},
          geometryId: {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: {model: 'keyboard_geometries', key: 'id'},
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          productId: {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: {model: 'keyboard_products', key: 'id'},
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          customBrand: {type: Sequelize.STRING(120), allowNull: true},
          customModel: {type: Sequelize.STRING(120), allowNull: true},
          sensing: {
            type: Sequelize.ENUM('mechanical', 'optical', 'hall', 'other'),
            allowNull: true,
          },
          switchId: {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: {model: 'keyboard_switches', key: 'id'},
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          customSwitch: {type: Sequelize.STRING(120), allowNull: true},
          actuationMm: {type: Sequelize.DECIMAL(4, 2), allowNull: true},
          rapidTriggerActuationMm: {type: Sequelize.DECIMAL(4, 2), allowNull: true},
          colorway: {type: Sequelize.STRING(120), allowNull: true},
          note: {type: Sequelize.STRING(500), allowNull: true},
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
        },
        {transaction},
      );
      await queryInterface.addIndex('keyboard_board_periods', ['rigId', 'sinceDate'], {
        name: 'idx_keyboard_board_periods_rig_since',
        transaction,
      });

      await queryInterface.createTable(
        'keyboard_board_period_keys',
        {
          id: {type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true},
          boardPeriodId: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: {model: 'keyboard_board_periods', key: 'id'},
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          keyCode: {type: Sequelize.STRING(64), allowNull: false},
          socketEmpty: {type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false},
          switchId: {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: {model: 'keyboard_switches', key: 'id'},
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          customSwitch: {type: Sequelize.STRING(120), allowNull: true},
        },
        {transaction},
      );
      await queryInterface.addIndex('keyboard_board_period_keys', ['boardPeriodId', 'keyCode'], {
        unique: true,
        name: 'uniq_keyboard_board_period_keys_code',
        transaction,
      });

      await queryInterface.createTable(
        'keyboard_lanes',
        {
          id: {type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true},
          rigId: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: {model: 'keyboard_rigs', key: 'id'},
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          keyCount: {type: Sequelize.INTEGER, allowNull: false},
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
        },
        {transaction},
      );
      await queryInterface.addIndex('keyboard_lanes', ['rigId', 'keyCount'], {
        unique: true,
        name: 'uniq_keyboard_lanes_rig_count',
        transaction,
      });

      await queryInterface.createTable(
        'keyboard_lane_periods',
        {
          id: {type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true},
          laneId: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: {model: 'keyboard_lanes', key: 'id'},
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          sinceDate: {type: Sequelize.DATEONLY, allowNull: true},
          keysJson: {type: Sequelize.JSON, allowNull: true},
          keySignature: {type: Sequelize.STRING(1024), allowNull: true},
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
        },
        {transaction},
      );
      await queryInterface.addIndex('keyboard_lane_periods', ['laneId', 'sinceDate'], {
        name: 'idx_keyboard_lane_periods_lane_since',
        transaction,
      });

      await queryInterface.createTable(
        'pass_bind_overrides',
        {
          passId: {type: Sequelize.INTEGER, primaryKey: true},
          playerId: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: {model: 'players', key: 'id'},
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          lanePeriodId: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: {model: 'keyboard_lane_periods', key: 'id'},
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
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
          },
        },
        {transaction},
      );
      await queryInterface.addIndex('pass_bind_overrides', ['playerId'], {
        name: 'idx_pass_bind_overrides_player_id',
        transaction,
      });
      await queryInterface.addIndex('pass_bind_overrides', ['lanePeriodId'], {
        name: 'idx_pass_bind_overrides_lane_period_id',
        transaction,
      });

      const now = new Date();
      await queryInterface.bulkInsert(
        'keyboard_geometries',
        seed.geometries.map((row) => ({
          slug: row.slug,
          name: row.name,
          formFactor: row.formFactor,
          keysJson: JSON.stringify(row.keys),
          createdAt: now,
          updatedAt: now,
        })),
        {transaction},
      );

      const [geometryRows] = await queryInterface.sequelize.query(
        'SELECT id, slug FROM keyboard_geometries',
        {transaction},
      );
      const geometryIdBySlug = Object.fromEntries(
        geometryRows.map((row) => [row.slug, row.id]),
      );

      await queryInterface.bulkInsert(
        'keyboard_products',
        seed.products.map((row) => ({
          geometryId: geometryIdBySlug[row.slugGeometry],
          brand: row.brand,
          model: row.model,
          createdAt: now,
          updatedAt: now,
        })),
        {transaction},
      );

      await queryInterface.bulkInsert(
        'keyboard_switches',
        seed.switches.map((row) => ({
          name: row.name,
          sensing: row.sensing,
          createdAt: now,
          updatedAt: now,
        })),
        {transaction},
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.dropTable('pass_bind_overrides', {transaction});
      await queryInterface.dropTable('keyboard_lane_periods', {transaction});
      await queryInterface.dropTable('keyboard_lanes', {transaction});
      await queryInterface.dropTable('keyboard_board_period_keys', {transaction});
      await queryInterface.dropTable('keyboard_board_periods', {transaction});
      await queryInterface.dropTable('keyboard_rigs', {transaction});
      await queryInterface.dropTable('keyboard_products', {transaction});
      await queryInterface.dropTable('keyboard_switches', {transaction});
      await queryInterface.dropTable('keyboard_geometries', {transaction});
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
