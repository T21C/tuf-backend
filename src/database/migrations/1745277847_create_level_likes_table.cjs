'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // First add likes column to levels table
    await queryInterface.addColumn('levels', 'likes', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0
    });

    // Create the level_likes table
    await queryInterface.createTable('level_likes', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
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

    // Add unique constraint to prevent duplicate likes
    await queryInterface.addConstraint('level_likes', {
      fields: ['userId', 'levelId'],
      type: 'unique',
      name: 'unique_user_level_like'
    });

    // Add indexes for better query performance
    await queryInterface.addIndex('level_likes', ['userId']);
    await queryInterface.addIndex('level_likes', ['levelId']);
    await queryInterface.addIndex('level_likes', ['levelId', 'userId'], {
      unique: true
    });

    // Create stored procedure to recalculate likes count
    await queryInterface.sequelize.query(`
      DROP PROCEDURE IF EXISTS recalculate_level_likes_count;
    `);

    await queryInterface.sequelize.query(`
      CREATE PROCEDURE recalculate_level_likes_count(IN level_id INT)
      BEGIN
        UPDATE levels
        SET likes = (
          SELECT COUNT(*)
          FROM level_likes ll
          WHERE ll.levelId = level_id
        )
        WHERE id = level_id;
      END
    `);

    // Create trigger for likes count
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_likes_on_like_change;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_level_likes_on_like_change
      AFTER INSERT ON level_likes
      FOR EACH ROW
      BEGIN
        CALL recalculate_level_likes_count(NEW.levelId);
      END
    `);

    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_likes_on_like_delete;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_level_likes_on_like_delete
      AFTER DELETE ON level_likes
      FOR EACH ROW
      BEGIN
        CALL recalculate_level_likes_count(OLD.levelId);
      END
    `);

    // Recalculate likes counts for all levels
    await queryInterface.sequelize.query(`
      UPDATE levels l
      SET likes = (
        SELECT COUNT(*)
        FROM level_likes ll
        WHERE ll.levelId = l.id
      );
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
    // Drop triggers
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_likes_on_like_change;
    `);
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_level_likes_on_like_delete;
    `);

    // Drop procedure
    await queryInterface.sequelize.query(`
      DROP PROCEDURE IF EXISTS recalculate_level_likes_count;
    `);

    // Drop the table
    await queryInterface.dropTable('level_likes');

    // Remove likes column from levels
    await queryInterface.removeColumn('levels', 'likes');

    // Recreate the view without likes
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