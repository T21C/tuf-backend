'use strict';

const BOARD_SENSING = "ENUM('mechanical','optical','hall','membrane','other')";
const SWITCH_SENSING = "ENUM('mechanical','optical','hall','other')";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE keyboard_board_periods MODIFY COLUMN sensing ${BOARD_SENSING} NULL`,
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      "UPDATE keyboard_board_periods SET sensing = 'other' WHERE sensing = 'membrane'",
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE keyboard_board_periods MODIFY COLUMN sensing ${SWITCH_SENSING} NULL`,
    );
  },
};
