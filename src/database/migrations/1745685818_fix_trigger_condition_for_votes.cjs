'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {

    // Create BEFORE trigger for rating accuracy on insert
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_rating_accuracy_on_vote_insert;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_level_rating_accuracy_on_vote_insert
      AFTER INSERT ON level_rating_accuracy_vote
      FOR EACH ROW
      BEGIN
        -- Calculate the new average for this level and difficulty
        SET @new_avg = (
          SELECT COALESCE(AVG(vote), 0)
          FROM (
            SELECT vote FROM level_rating_accuracy_vote 
            WHERE levelId = NEW.levelId AND diffId = NEW.diffId
            UNION ALL
            SELECT NEW.vote
          ) AS combined_votes
        );
        
        -- Update the level's rating accuracy
        UPDATE levels
        SET ratingAccuracy = @new_avg
        WHERE id = NEW.levelId AND diffId = NEW.diffId;
      END
    `);

    // Create BEFORE trigger for rating accuracy on update
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_rating_accuracy_on_vote_update;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_level_rating_accuracy_on_vote_update
      AFTER UPDATE ON level_rating_accuracy_vote
      FOR EACH ROW
      BEGIN
        -- Calculate the new average for this level and difficulty
        SET @new_avg = (
          SELECT COALESCE(AVG(vote), 0)
          FROM (
            SELECT vote FROM level_rating_accuracy_vote 
            WHERE levelId = NEW.levelId AND diffId = NEW.diffId AND id != OLD.id
            UNION ALL
            SELECT NEW.vote
          ) AS combined_votes
        );
        
        -- Update the level's rating accuracy
        UPDATE levels
        SET ratingAccuracy = @new_avg
        WHERE id = NEW.levelId AND diffId = NEW.diffId;
      END
    `);

    // Create BEFORE trigger for rating accuracy on delete
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_rating_accuracy_on_vote_delete;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_level_rating_accuracy_on_vote_delete
      AFTER DELETE ON level_rating_accuracy_vote
      FOR EACH ROW
      BEGIN
        -- Calculate the new average for this level and difficulty
        SET @new_avg = (
          SELECT COALESCE(AVG(vote), 0)
          FROM level_rating_accuracy_vote
          WHERE levelId = OLD.levelId AND diffId = OLD.diffId AND id != OLD.id
        );
        
        -- Update the level's rating accuracy
        UPDATE levels
        SET ratingAccuracy = @new_avg
        WHERE id = OLD.levelId AND diffId = OLD.diffId;
      END
    `);
  },

  async down(queryInterface, Sequelize) {
  }
}; 