'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // First add likes column to levels table
    try{
      await queryInterface.addColumn('levels', 'ratingAccuracy', {
        type: Sequelize.DOUBLE,
        allowNull: false,
        defaultValue: 0
      });
    } catch (error) {
      console.log('Error adding ratingAccuracy column:', error);
    }

    // Create the level_likes table
    try{
      await queryInterface.createTable('level_rating_accuracy_vote', {
        id: {
          allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      diffId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'difficulties',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      vote: {
        type: Sequelize.INTEGER,
        allowNull: false
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      levelId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'levels',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });
    } catch (error) {
      console.log('Error creating level_rating_accuracy_vote table:', error);
    }
    // Add unique constraint to prevent duplicate likes
    try{
      await queryInterface.addConstraint('level_rating_accuracy_vote', {
        fields: ['userId', 'levelId', 'diffId'],
        type: 'unique',
        name: 'unique_user_level_rating_accuracy_vote'
      });
    } catch (error) {
      console.log('Error adding unique constraint:', error);
    }

    // Add indexes for better query performance
    try{
      await queryInterface.addIndex('level_rating_accuracy_vote', ['userId']);
      await queryInterface.addIndex('level_rating_accuracy_vote', ['levelId']);
      await queryInterface.addIndex('level_rating_accuracy_vote', ['userId', 'levelId', 'diffId'], {
        unique: true
      });
    } catch (error) {
      console.log('Error adding indexes:', error);
    }

    // Create a view that will be used to get the current rating accuracy
    await queryInterface.sequelize.query(`
      DROP VIEW IF EXISTS level_rating_accuracy_view;
    `);

    await queryInterface.sequelize.query(`
      CREATE VIEW level_rating_accuracy_view AS
      SELECT 
        l.id AS levelId,
        l.diffId,
        COALESCE(AVG(v.vote), 0) AS currentRatingAccuracy
      FROM levels l
      LEFT JOIN level_rating_accuracy_vote v ON l.id = v.levelId AND l.diffId = v.diffId
      GROUP BY l.id, l.diffId
    `);

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
      CREATE TRIGGER update_level_rating_accuracy_on_vote_insert
      BEFORE INSERT ON level_rating_accuracy_vote
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
      CREATE TRIGGER update_level_rating_accuracy_on_vote_delete
      BEFORE DELETE ON level_rating_accuracy_vote
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

    // Create BEFORE trigger for difficulty changes
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_rating_accuracy_on_diff_change;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_level_rating_accuracy_on_diff_change
      BEFORE UPDATE ON levels
      FOR EACH ROW
      BEGIN
        IF NEW.diffId != OLD.diffId THEN
          -- Calculate the new average for the new difficulty
          SET @new_avg = (
            SELECT COALESCE(AVG(vote), 0)
            FROM level_rating_accuracy_vote
            WHERE levelId = NEW.id AND diffId = NEW.diffId
          );
          
          -- Update the level's rating accuracy
          SET NEW.ratingAccuracy = @new_avg;
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
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('level_rating_accuracy_vote');
    
    await queryInterface.removeColumn('levels', 'ratingAccuracy');
    
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_rating_accuracy_on_vote_insert;
    `);
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_rating_accuracy_on_vote_update;
    `);
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_rating_accuracy_on_vote_delete;
    `);
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_rating_accuracy_on_diff_change;
    `);
    await queryInterface.sequelize.query(`
      DROP VIEW IF EXISTS level_rating_accuracy_view;
    `);

    await queryInterface.sequelize.query(`
      DROP PROCEDURE IF EXISTS update_level_rating_accuracy;
    `);
    
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