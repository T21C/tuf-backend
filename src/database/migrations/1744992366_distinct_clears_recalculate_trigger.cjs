'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Create a stored procedure to recalculate clear count for a level
    await queryInterface.sequelize.query(`
      DROP PROCEDURE IF EXISTS recalculate_level_clear_count;
    `);

    await queryInterface.sequelize.query(`
      CREATE PROCEDURE recalculate_level_clear_count(IN level_id INT)
      BEGIN
        UPDATE levels
        SET clears = (
          SELECT COUNT(*)
          FROM passes p
          JOIN players as pl ON p.playerId = pl.id
          WHERE p.levelId = level_id
          AND p.isDeleted = false
          AND pl.isBanned = false
        )
        WHERE id = level_id;
      END
    `);

    // Create a trigger to recalculate clear count when a pass is updated
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_clears_on_pass_update;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_level_clears_on_pass_update
      AFTER UPDATE ON passes
      FOR EACH ROW
      BEGIN
        -- If levelId changed, recalculate clear count for both old and new levels
        IF OLD.levelId != NEW.levelId THEN
          CALL recalculate_level_clear_count(OLD.levelId);
          CALL recalculate_level_clear_count(NEW.levelId);
        -- If isDeleted status changed, recalculate clear count for the level
        ELSEIF OLD.isDeleted != NEW.isDeleted THEN
          CALL recalculate_level_clear_count(NEW.levelId);
        END IF;
      END
    `);

    // Recalculate clear counts for all levels to ensure consistency
    await queryInterface.sequelize.query(`
      UPDATE levels l
      SET clears = (
          SELECT COUNT(*)
          FROM passes p
          JOIN players as pl ON p.playerId = pl.id
          WHERE p.levelId = l.id
          AND p.isDeleted = false
          AND pl.isBanned = false
      );
    `);

    console.log('Created clear count recalculation trigger and procedure');
  },

  async down(queryInterface, Sequelize) {
    // Drop triggers
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_clears_on_pass_update;
    `);

    // Drop procedures
    await queryInterface.sequelize.query(`
      DROP PROCEDURE IF EXISTS recalculate_level_clear_count;
    `);
  }
}; 