'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
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
          JOIN players pl ON p.playerId = pl.id
          WHERE p.levelId = level_id
            AND p.isDeleted = false
            AND p.isHidden = false
            AND pl.isBanned = false
        )
        WHERE id = level_id;
      END
    `);

    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_clears_on_pass_insert;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_level_clears_on_pass_insert
      AFTER INSERT ON passes
      FOR EACH ROW
      BEGIN
        CALL recalculate_level_clear_count(NEW.levelId);
      END
    `);

    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_clears_on_pass_delete;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_level_clears_on_pass_delete
      AFTER DELETE ON passes
      FOR EACH ROW
      BEGIN
        CALL recalculate_level_clear_count(OLD.levelId);
      END
    `);

    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_clears_on_pass_update;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_level_clears_on_pass_update
      AFTER UPDATE ON passes
      FOR EACH ROW
      BEGIN
        IF OLD.levelId != NEW.levelId THEN
          CALL recalculate_level_clear_count(OLD.levelId);
          CALL recalculate_level_clear_count(NEW.levelId);
        ELSEIF OLD.isDeleted != NEW.isDeleted THEN
          CALL recalculate_level_clear_count(NEW.levelId);
        ELSEIF OLD.isHidden != NEW.isHidden THEN
          CALL recalculate_level_clear_count(NEW.levelId);
        END IF;
      END
    `);

    await queryInterface.sequelize.query(`
      UPDATE levels l
      SET clears = (
        SELECT COUNT(*)
        FROM passes p
        JOIN players pl ON p.playerId = pl.id
        WHERE p.levelId = l.id
          AND p.isDeleted = false
          AND p.isHidden = false
          AND pl.isBanned = false
      );
    `);

    console.log('Aligned levels.clears triggers/procedure to include isHidden filter');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_clears_on_pass_update;
    `);
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_clears_on_pass_insert;
    `);
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_clears_on_pass_delete;
    `);
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

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_level_clears_on_pass_insert
      AFTER INSERT ON passes
      FOR EACH ROW
      BEGIN
        UPDATE levels
        SET clears = clears + 1
        WHERE id = NEW.levelId;
      END
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_level_clears_on_pass_delete
      AFTER DELETE ON passes
      FOR EACH ROW
      BEGIN
        UPDATE levels
        SET clears = clears - 1
        WHERE id = OLD.levelId;
      END
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_level_clears_on_pass_update
      AFTER UPDATE ON passes
      FOR EACH ROW
      BEGIN
        IF OLD.levelId != NEW.levelId THEN
          CALL recalculate_level_clear_count(OLD.levelId);
          CALL recalculate_level_clear_count(NEW.levelId);
        ELSEIF OLD.isDeleted != NEW.isDeleted THEN
          CALL recalculate_level_clear_count(NEW.levelId);
        END IF;
      END
    `);
  }
};
