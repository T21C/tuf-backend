'use strict';

/** Ghost keys are a secondary usage of keys already selected on a layout. */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('keyboard_lane_periods');
    if (!table.ghostKeysJson) {
      await queryInterface.addColumn('keyboard_lane_periods', 'ghostKeysJson', {
        type: Sequelize.JSON,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('keyboard_lane_periods');
    if (table.ghostKeysJson) {
      await queryInterface.removeColumn('keyboard_lane_periods', 'ghostKeysJson');
    }
  },
};
