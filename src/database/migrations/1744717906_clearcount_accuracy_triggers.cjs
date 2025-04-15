'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // First add the columns to store the values
    try {
      await queryInterface.addColumn('levels', 'clears', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      });
    } catch (error) {
      console.error('Error adding clears column:', error);
    }
    
    try {
      await queryInterface.addColumn('judgements', 'accuracy', {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: null
      });
    } catch (error) {
      console.error('Error adding accuracy column:', error);
    }
    
    // Create a function to calculate accuracy
    await queryInterface.sequelize.query(`
      DROP FUNCTION IF EXISTS calculate_accuracy;
    `);
    
    await queryInterface.sequelize.query(`
      CREATE FUNCTION calculate_accuracy(
        early_double BIGINT UNSIGNED,
        early_single BIGINT UNSIGNED,
        e_perfect BIGINT UNSIGNED,
        perfect BIGINT UNSIGNED,
        l_perfect BIGINT UNSIGNED,
        late_single BIGINT UNSIGNED,
        late_double BIGINT UNSIGNED
      ) RETURNS DOUBLE
      DETERMINISTIC
      BEGIN
        DECLARE total_tiles BIGINT UNSIGNED;
        DECLARE weighted_sum DOUBLE;
        DECLARE result DOUBLE;
        
        SET total_tiles = early_double + early_single + e_perfect + perfect + l_perfect + late_single + late_double;
        
        IF total_tiles = 0 THEN
          RETURN NULL;
        END IF;
        
        -- Calculate weighted sum based on the calcAcc function in CalcAcc.ts
        -- perfect = 1.0, ePerfect/lPerfect = 0.75, earlySingle/lateSingle = 0.4, earlyDouble/lateDouble = 0.2
        SET weighted_sum = perfect + 
                          (e_perfect + l_perfect) * 0.75 + 
                          (early_single + late_single) * 0.4 + 
                          (early_double + late_double) * 0.2;
        
        SET result = weighted_sum / total_tiles;
        
        RETURN result;
      END
    `);
    
    // Create a trigger to update judgement accuracy when a judgement is inserted or updated
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_judgement_accuracy;
    `);
    
    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_judgement_accuracy
      BEFORE INSERT ON judgements
      FOR EACH ROW
      BEGIN
        SET NEW.accuracy = calculate_accuracy(
          NEW.earlyDouble,
          NEW.earlySingle,
          NEW.ePerfect,
          NEW.perfect,
          NEW.lPerfect,
          NEW.lateSingle,
          NEW.lateDouble
        );
      END
    `);
    
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_judgement_accuracy_on_update;
    `);
    
    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_judgement_accuracy_on_update
      BEFORE UPDATE ON judgements
      FOR EACH ROW
      BEGIN
        SET NEW.accuracy = calculate_accuracy(
          NEW.earlyDouble,
          NEW.earlySingle,
          NEW.ePerfect,
          NEW.perfect,
          NEW.lPerfect,
          NEW.lateSingle,
          NEW.lateDouble
        );
      END
    `);
    
    // Create a trigger to update level clear count when a pass is inserted
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_clears_on_pass_insert;
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
      DROP TRIGGER IF EXISTS update_level_clears_on_pass_delete;
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
    
    // Update existing data
    // First, update all judgements with calculated accuracy
    await queryInterface.sequelize.query(`
      UPDATE judgements
      SET accuracy = calculate_accuracy(
        earlyDouble,
        earlySingle,
        ePerfect,
        perfect,
        lPerfect,
        lateSingle,
        lateDouble
      )
      WHERE accuracy IS NULL;
    `);
    
    // Then, update all levels with the correct clear count
    await queryInterface.sequelize.query(`
      UPDATE levels l
      SET clears = (
        SELECT COUNT(*)
        FROM passes p
        WHERE p.levelId = l.id
      );
    `);
  },

  async down(queryInterface, Sequelize) {
    // Drop triggers
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_judgement_accuracy;
    `);
    
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_judgement_accuracy_on_update;
    `);
      
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_clears_on_pass_insert;
    `);

    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_clears_on_pass_delete;
    `);

    // Drop function
    await queryInterface.sequelize.query(`
      DROP FUNCTION IF EXISTS calculate_accuracy;
    `);
    
    // Remove columns
    await queryInterface.removeColumn('judgements', 'accuracy');
    await queryInterface.removeColumn('levels', 'clears');
  }
}; 