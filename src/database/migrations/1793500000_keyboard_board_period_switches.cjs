'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('keyboard_board_period_switches', {
      id: {type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true},
      boardPeriodId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {model: 'keyboard_board_periods', key: 'id'},
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      sortOrder: {type: Sequelize.INTEGER, allowNull: false, defaultValue: 0},
      switchId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {model: 'keyboard_switches', key: 'id'},
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      customSwitch: {type: Sequelize.STRING(120), allowNull: true},
      stemColor: {type: Sequelize.STRING(7), allowNull: true},
      baseColor: {type: Sequelize.STRING(7), allowNull: true},
      topColor: {type: Sequelize.STRING(7), allowNull: true},
      baseOpacity: {type: Sequelize.DECIMAL(3, 2), allowNull: true},
    });
    await queryInterface.addIndex('keyboard_board_period_switches', ['boardPeriodId', 'sortOrder'], {
      unique: true,
      name: 'uniq_keyboard_board_period_switches_order',
    });

    await queryInterface.addColumn('keyboard_board_period_keys', 'periodSwitchId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: {model: 'keyboard_board_period_switches', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('keyboard_board_period_keys', 'actuationMm', {
      type: Sequelize.DECIMAL(4, 2),
      allowNull: true,
    });
    await queryInterface.addColumn('keyboard_board_period_keys', 'rapidTriggerSplit', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });
    await queryInterface.addColumn('keyboard_board_period_keys', 'rapidTriggerActuationMm', {
      type: Sequelize.DECIMAL(4, 2),
      allowNull: true,
    });
    await queryInterface.addColumn('keyboard_board_period_keys', 'rapidTriggerPressMm', {
      type: Sequelize.DECIMAL(4, 2),
      allowNull: true,
    });
    await queryInterface.addColumn('keyboard_board_period_keys', 'rapidTriggerReleaseMm', {
      type: Sequelize.DECIMAL(4, 2),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('keyboard_board_period_keys', 'rapidTriggerReleaseMm');
    await queryInterface.removeColumn('keyboard_board_period_keys', 'rapidTriggerPressMm');
    await queryInterface.removeColumn('keyboard_board_period_keys', 'rapidTriggerActuationMm');
    await queryInterface.removeColumn('keyboard_board_period_keys', 'rapidTriggerSplit');
    await queryInterface.removeColumn('keyboard_board_period_keys', 'actuationMm');
    await queryInterface.removeColumn('keyboard_board_period_keys', 'periodSwitchId');
    await queryInterface.dropTable('keyboard_board_period_switches');
  },
};
