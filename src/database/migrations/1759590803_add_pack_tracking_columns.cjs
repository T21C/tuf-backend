'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Add columns to store the tracking values
    try {
      await queryInterface.addColumn('level_packs', 'favoritesCount', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      });
    } catch (error) {
      console.error('Error adding favoritesCount column:', error);
    }
    
    try {
      await queryInterface.addColumn('level_packs', 'levelCount', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      });
    } catch (error) {
      console.error('Error adding levelCount column:', error);
    }
    
    // Create a stored procedure to recalculate favorites count for a pack
    await queryInterface.sequelize.query(`
      DROP PROCEDURE IF EXISTS recalculate_pack_favorites_count;
    `);
    
    await queryInterface.sequelize.query(`
      CREATE PROCEDURE recalculate_pack_favorites_count(IN pack_id INT)
      BEGIN
        UPDATE level_packs
        SET favoritesCount = (
          SELECT COUNT(*)
          FROM pack_favorites pf
          WHERE pf.packId = pack_id
        )
        WHERE id = pack_id;
      END
    `);
    
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
          WHERE lpi.packId = pack_id
          AND lpi.type = 'level'
        )
        WHERE id = pack_id;
      END
    `);
    
    // Create triggers to update favorites count when pack_favorites changes
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pack_favorites_count_on_insert;
    `);
    
    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_pack_favorites_count_on_insert
      AFTER INSERT ON pack_favorites
      FOR EACH ROW
      BEGIN
        CALL recalculate_pack_favorites_count(NEW.packId);
      END
    `);
    
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pack_favorites_count_on_delete;
    `);
    
    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_pack_favorites_count_on_delete
      AFTER DELETE ON pack_favorites
      FOR EACH ROW
      BEGIN
        CALL recalculate_pack_favorites_count(OLD.packId);
      END
    `);
    
    // Create triggers to update level count when level_pack_items changes
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pack_level_count_on_insert;
    `);
    
    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_pack_level_count_on_insert
      AFTER INSERT ON level_pack_items
      FOR EACH ROW
      BEGIN
        IF NEW.type = 'level' THEN
          CALL recalculate_pack_level_count(NEW.packId);
        END IF;
      END
    `);
    
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pack_level_count_on_delete;
    `);
    
    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_pack_level_count_on_delete
      AFTER DELETE ON level_pack_items
      FOR EACH ROW
      BEGIN
        IF OLD.type = 'level' THEN
          CALL recalculate_pack_level_count(OLD.packId);
        END IF;
      END
    `);
    
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pack_level_count_on_update;
    `);
    
    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_pack_level_count_on_update
      AFTER UPDATE ON level_pack_items
      FOR EACH ROW
      BEGIN
        -- If packId changed, update both old and new packs
        IF OLD.packId != NEW.packId THEN
          IF OLD.type = 'level' THEN
            CALL recalculate_pack_level_count(OLD.packId);
          END IF;
          IF NEW.type = 'level' THEN
            CALL recalculate_pack_level_count(NEW.packId);
          END IF;
        -- If type changed, update the pack
        ELSEIF OLD.type != NEW.type THEN
          CALL recalculate_pack_level_count(NEW.packId);
        END IF;
      END
    `);
    
    // Update existing data
    // First, update all packs with the correct favorites count
    await queryInterface.sequelize.query(`
      UPDATE level_packs lp
      SET favoritesCount = (
        SELECT COUNT(*)
        FROM pack_favorites pf
        WHERE pf.packId = lp.id
      );
    `);
    
    // Then, update all packs with the correct level count
    await queryInterface.sequelize.query(`
      UPDATE level_packs lp
      SET levelCount = (
        SELECT COUNT(*)
        FROM level_pack_items lpi
        WHERE lpi.packId = lp.id
        AND lpi.type = 'level'
      );
    `);
  },

  async down(queryInterface, Sequelize) {
    // Drop triggers
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pack_favorites_count_on_insert;
    `);
    
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pack_favorites_count_on_delete;
    `);
      
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pack_level_count_on_insert;
    `);

    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pack_level_count_on_delete;
    `);

    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pack_level_count_on_update;
    `);

    // Drop procedures
    await queryInterface.sequelize.query(`
      DROP PROCEDURE IF EXISTS recalculate_pack_favorites_count;
    `);
    
    await queryInterface.sequelize.query(`
      DROP PROCEDURE IF EXISTS recalculate_pack_level_count;
    `);
    
    // Remove columns
    await queryInterface.removeColumn('level_packs', 'favoritesCount');
    await queryInterface.removeColumn('level_packs', 'levelCount');
  }
};
