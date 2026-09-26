'use strict';

/** Layouts are named by the player. Count-shaped names stay in sync in the client. */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('keyboard_lanes');
    if (!table.name) {
      await queryInterface.addColumn('keyboard_lanes', 'name', {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: '',
      });
    }
    await queryInterface.sequelize.query(
      "UPDATE keyboard_lanes SET name = CONCAT(keyCount, 'K') WHERE name = ''",
    );
    const indexes = await queryInterface.showIndex('keyboard_lanes');
    if (!indexes.some((row) => row.name === 'keyboard_lanes_rig')) {
      await queryInterface.addIndex('keyboard_lanes', ['rigId'], {
        name: 'keyboard_lanes_rig',
      });
    }
    if (indexes.some((row) => row.name === 'uniq_keyboard_lanes_rig_count')) {
      await queryInterface.removeIndex('keyboard_lanes', 'uniq_keyboard_lanes_rig_count');
    }
  },

  async down(queryInterface) {
    await queryInterface.addIndex('keyboard_lanes', ['rigId', 'keyCount'], {
      unique: true,
      name: 'uniq_keyboard_lanes_rig_count',
    });
    const indexes = await queryInterface.showIndex('keyboard_lanes');
    if (indexes.some((row) => row.name === 'keyboard_lanes_rig')) {
      await queryInterface.removeIndex('keyboard_lanes', 'keyboard_lanes_rig');
    }
    await queryInterface.removeColumn('keyboard_lanes', 'name');
  },
};
