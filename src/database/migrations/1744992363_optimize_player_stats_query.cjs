'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Add accuracy column to passes table
    try{
      await queryInterface.removeColumn('passes', 'accuracy');
    } catch (error) {
      console.error('Error removing accuracy column from passes:', error);
    }

    try {
      await queryInterface.addColumn('passes', 'accuracy', {
        type: Sequelize.DOUBLE,
        allowNull: true,
        defaultValue: null
      });
      console.log('Added accuracy column to passes table');
    } catch (error) {
      console.error('Error adding accuracy column to passes:', error);
    }

    // 2. Add composite indexes to optimize the player stats query
    try {
      // Index for filtering by playerId and isDeleted
      await queryInterface.addIndex('passes', ['playerId', 'isDeleted', 'scoreV2'], {
        name: 'idx_passes_player_deleted_score'
      });
      console.log('Added composite index for playerId, isDeleted, scoreV2');
    } catch (error) {
      console.error('Error adding playerId, isDeleted, scoreV2 index:', error);
    }

    try {
      // Index for filtering by playerId and levelId
      await queryInterface.addIndex('passes', ['playerId', 'levelId', 'scoreV2'], {
        name: 'idx_passes_player_level_score'
      });
      console.log('Added composite index for playerId, levelId, scoreV2');
    } catch (error) {
      console.error('Error adding playerId, levelId, scoreV2 index:', error);
    }

    try {
      // Index for filtering by playerId, isDeleted, and is12K
      await queryInterface.addIndex('passes', ['playerId', 'isDeleted', 'is12K'], {
        name: 'idx_passes_player_deleted_12k'
      });
      console.log('Added composite index for playerId, isDeleted, is12K');
    } catch (error) {
      console.error('Error adding playerId, isDeleted, is12K index:', error);
    }

    try {
      // Index for filtering by playerId, isDeleted, and isWorldsFirst
      await queryInterface.addIndex('passes', ['playerId', 'isDeleted', 'isWorldsFirst'], {
        name: 'idx_passes_player_deleted_wf'
      });
      console.log('Added composite index for playerId, isDeleted, isWorldsFirst');
    } catch (error) {
      console.error('Error adding playerId, isDeleted, isWorldsFirst index:', error);
    }

    // 3. Create a trigger to update the accuracy column in passes when a judgement is inserted or updated
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pass_accuracy_on_judgement;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_pass_accuracy_on_judgement
      AFTER INSERT ON judgements
      FOR EACH ROW
      BEGIN
        UPDATE passes
        SET accuracy = NEW.accuracy
        WHERE id = NEW.id;
      END
    `);
    console.log('Created trigger to update pass accuracy on judgement insert');

    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pass_accuracy_on_judgement_update;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_pass_accuracy_on_judgement_update
      AFTER UPDATE ON judgements
      FOR EACH ROW
      BEGIN
        UPDATE passes
        SET accuracy = NEW.accuracy
        WHERE id = NEW.id;
      END
    `);
    console.log('Created trigger to update pass accuracy on judgement update');

    // 4. Update existing passes with accuracy values from judgements
    await queryInterface.sequelize.query(`
      UPDATE passes p
      JOIN judgements j ON j.id = p.id
      SET p.accuracy = j.accuracy
      WHERE p.accuracy IS NULL;
    `);
    console.log('Updated existing passes with accuracy values from judgements');
  },

  async down(queryInterface, Sequelize) {
    // 1. Drop triggers
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pass_accuracy_on_judgement;
    `);
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pass_accuracy_on_judgement_update;
    `);
    console.log('Dropped triggers for updating pass accuracy');

    // 2. Remove indexes
    try {
      await queryInterface.removeIndex('passes', 'idx_passes_player_deleted_score');
    } catch (error) {
      console.error('Error removing idx_passes_player_deleted_score index:', error);
    }

    try {
      await queryInterface.removeIndex('passes', 'idx_passes_player_level_score');
    } catch (error) {
      console.error('Error removing idx_passes_player_level_score index:', error);
    }

    try {
      await queryInterface.removeIndex('passes', 'idx_passes_player_deleted_12k');
    } catch (error) {
      console.error('Error removing idx_passes_player_deleted_12k index:', error);
    }

    try {
      await queryInterface.removeIndex('passes', 'idx_passes_player_deleted_wf');
    } catch (error) {
      console.error('Error removing idx_passes_player_deleted_wf index:', error);
    }

    // 3. Remove accuracy column from passes
    try {
      await queryInterface.removeColumn('passes', 'accuracy');
      console.log('Removed accuracy column from passes table');
    } catch (error) {
      console.error('Error removing accuracy column from passes:', error);
    }
  }
}; 