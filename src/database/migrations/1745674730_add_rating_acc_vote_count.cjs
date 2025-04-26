'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // First add likes column to levels table
    try{
      await queryInterface.addColumn('levels', 'totalRatingAccuracyVotes', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      });
    } catch (error) {
      console.log('Error adding totalRatingAccuracyVotes column:', error);
    }



    // Create a stored procedure to update rating accuracy for a level
    await queryInterface.sequelize.query(`
      DROP PROCEDURE IF EXISTS update_level_rating_accuracy;
    `);

    await queryInterface.sequelize.query(`
      CREATE PROCEDURE update_level_rating_accuracy(IN level_id INT, IN diff_id INT)
      BEGIN
        UPDATE levels l
        JOIN level_rating_accuracy_view v ON l.id = v.levelId AND l.diffId = v.diffId
        SET l.ratingAccuracy = v.currentRatingAccuracy
        WHERE l.id = level_id AND l.diffId = diff_id;
      END
    `);

    // Create BEFORE trigger for rating accuracy on insert
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_rating_accuracy_on_vote_insert;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_level_total_rating_accuracy_votes_on_vote_insert
      BEFORE INSERT ON level_rating_accuracy_vote
      FOR EACH ROW
      BEGIN
        -- Calculate the new average for this level and difficulty
        SET @new_total = (
          SELECT COUNT(*)
          FROM (
            SELECT vote FROM level_rating_accuracy_vote 
            WHERE levelId = NEW.levelId AND diffId = NEW.diffId
            UNION ALL
            SELECT NEW.vote
          ) AS combined_votes
        );
        
        -- Update the level's rating accuracy
        UPDATE levels
        SET totalRatingAccuracyVotes = @new_total
        WHERE id = NEW.levelId AND diffId = NEW.diffId;
      END
    `);

    // Create BEFORE trigger for rating accuracy on update
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_rating_accuracy_on_vote_update;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_level_rating_accuracy_on_vote_update
      BEFORE UPDATE ON level_rating_accuracy_vote
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
      CREATE TRIGGER update_level_total_rating_accuracy_votes_on_vote_delete
      BEFORE DELETE ON level_rating_accuracy_vote
      FOR EACH ROW
      BEGIN
        -- Calculate the new average for this level and difficulty
        SET @new_total = (
          SELECT COUNT(*)
          FROM level_rating_accuracy_vote
          WHERE levelId = OLD.levelId AND diffId = OLD.diffId AND id != OLD.id
        );
        
        -- Update the level's rating accuracy
        UPDATE levels
        SET totalRatingAccuracyVotes = @new_total
        WHERE id = OLD.levelId AND diffId = OLD.diffId;
      END
    `);

    // Create BEFORE trigger for difficulty changes
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_total_rating_accuracy_votes_on_diff_change;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_level_total_rating_accuracy_votes_on_diff_change
      BEFORE UPDATE ON levels
      FOR EACH ROW
      BEGIN
        IF NEW.diffId != OLD.diffId THEN
          -- Calculate the new average for the new difficulty
          SET @new_total = (
            SELECT COUNT(*)
            FROM level_rating_accuracy_vote
            WHERE levelId = NEW.id AND diffId = NEW.diffId
          );
          
          -- Update the level's rating accuracy
          SET NEW.totalRatingAccuracyVotes = @new_total;
        END IF;
      END
    `);

    // Update the view to include likes count
    await queryInterface.sequelize.query(`
      DROP VIEW IF EXISTS level_search_view;
    `);

    await queryInterface.sequelize.query(`
      CREATE VIEW level_search_view AS
      SELECT 
        l.id,
        l.song,
        l.artist,
        l.charter,
        l.team,
        l.teamId,
        l.diffId,
        l.baseScore,
        l.clears,
        l.likes,
        l.ratingAccuracy,
        l.totalRatingAccuracyVotes,
        l.isDeleted,
        l.isHidden,
        l.isAnnounced,
        l.toRate,
        l.createdAt,
        l.updatedAt,
        d.sortOrder,
        d.type,
        d.name AS difficultyName,
        d.color AS difficultyColor,
        t.name AS teamName
      FROM levels l
      LEFT JOIN difficulties d ON l.diffId = d.id
      LEFT JOIN teams t ON l.teamId = t.id
      WHERE l.isDeleted = false;
    `);

    await queryInterface.sequelize.query(`
      UPDATE levels SET totalRatingAccuracyVotes = 0 WHERE totalRatingAccuracyVotes IS NULL;
    `);

    // Initialize totalRatingAccuracyVotes for all existing levels
    await queryInterface.sequelize.query(`
      UPDATE levels l
      SET l.totalRatingAccuracyVotes = (
        SELECT COUNT(*)
        FROM level_rating_accuracy_vote v
        WHERE v.levelId = l.id AND v.diffId = l.diffId
      );
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('level_rating_accuracy_vote');
    
    await queryInterface.removeColumn('levels', 'ratingAccuracy');
    
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_total_rating_accuracy_votes_on_vote_insert;
    `);
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_total_rating_accuracy_votes_on_vote_update;
    `);
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_total_rating_accuracy_votes_on_vote_delete;
    `);
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_total_rating_accuracy_votes_on_diff_change;
    `);
    await queryInterface.sequelize.query(`
      DROP VIEW IF EXISTS level_search_view;
    `);

    await queryInterface.sequelize.query(`
      DROP PROCEDURE IF EXISTS update_level_total_rating_accuracy_votes;
    `);

    await queryInterface.sequelize.query(`
      CREATE VIEW level_search_view AS
      SELECT 
        l.id,
        l.song,
        l.artist,
        l.charter,
        l.team,
        l.teamId,
        l.diffId,
        l.baseScore,
        l.clears,
        l.likes,
        l.ratingAccuracy,
        l.isDeleted,
        l.isHidden,
        l.isAnnounced,
        l.toRate,
        l.createdAt,
        l.updatedAt,
        d.sortOrder,
        d.type,
        d.name AS difficultyName,
        d.color AS difficultyColor,
        t.name AS teamName
      FROM levels l
      LEFT JOIN difficulties d ON l.diffId = d.id
      LEFT JOIN teams t ON l.teamId = t.id
      WHERE l.isDeleted = false;
    `);
  }
}; 