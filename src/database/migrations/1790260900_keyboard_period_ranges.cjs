'use strict';

/** From–To ranges on board and layout periods. Auto To is stored as a null untilDate. */
module.exports = {
  async up(queryInterface, Sequelize) {
    async function addRangeColumns(tableName) {
      const table = await queryInterface.describeTable(tableName);
      if (!table.untilDate) {
        await queryInterface.addColumn(tableName, 'untilDate', {
          type: Sequelize.DATEONLY,
          allowNull: true,
        });
      }
      if (!table.untilAuto) {
        await queryInterface.addColumn(tableName, 'untilAuto', {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        });
      }
    }
    await addRangeColumns('keyboard_board_periods');
    await addRangeColumns('keyboard_lane_periods');
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('keyboard_lane_periods', 'untilAuto');
    await queryInterface.removeColumn('keyboard_lane_periods', 'untilDate');
    await queryInterface.removeColumn('keyboard_board_periods', 'untilAuto');
    await queryInterface.removeColumn('keyboard_board_periods', 'untilDate');
  },
};
