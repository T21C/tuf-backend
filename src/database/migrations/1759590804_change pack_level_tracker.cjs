'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Create a stored procedure to recalculate level count for a pack
    await queryInterface.sequelize.query(`
      DROP PROCEDURE IF EXISTS recalculate_pack_level_count;
    `);
    
    await queryInterface.sequelize.query(`
      CREATE PROCEDURE recalculate_pack_level_count(IN pack_id INT)
      BEGIN
        UPDATE level_packs
        SET levelCount = (
          SELECT COUNT(*)
          FROM level_pack_items lpi
          JOIN levels l ON lpi.levelId = l.id
          WHERE lpi.packId = pack_id
          AND lpi.type = 'level'
          AND l.isDeleted = false
          AND l.isHidden = false
        )
        WHERE id = pack_id;
      END
    `);
  },

  async down(queryInterface, Sequelize) {
  }
};
