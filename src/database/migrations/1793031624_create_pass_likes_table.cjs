'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('passes', 'likes', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });

    await queryInterface.createTable('pass_likes', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      passId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'passes',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
    });

    await queryInterface.addConstraint('pass_likes', {
      fields: ['userId', 'passId'],
      type: 'unique',
      name: 'unique_user_pass_like',
    });

    await queryInterface.addIndex('pass_likes', ['userId']);
    await queryInterface.addIndex('pass_likes', ['passId']);
    await queryInterface.addIndex('pass_likes', ['passId', 'userId'], {
      unique: true,
    });

    await queryInterface.sequelize.query(`
      DROP PROCEDURE IF EXISTS recalculate_pass_likes_count;
    `);

    await queryInterface.sequelize.query(`
      CREATE PROCEDURE recalculate_pass_likes_count(IN pass_id INT)
      BEGIN
        UPDATE passes
        SET likes = (
          SELECT COUNT(*)
          FROM pass_likes pl
          WHERE pl.passId = pass_id
        )
        WHERE id = pass_id;
      END
    `);

    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pass_likes_on_like_change;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_pass_likes_on_like_change
      AFTER INSERT ON pass_likes
      FOR EACH ROW
      BEGIN
        CALL recalculate_pass_likes_count(NEW.passId);
      END
    `);

    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pass_likes_on_like_delete;
    `);

    await queryInterface.sequelize.query(`
      CREATE TRIGGER update_pass_likes_on_like_delete
      AFTER DELETE ON pass_likes
      FOR EACH ROW
      BEGIN
        CALL recalculate_pass_likes_count(OLD.passId);
      END
    `);

    await queryInterface.sequelize.query(`
      UPDATE passes p
      SET likes = (
        SELECT COUNT(*)
        FROM pass_likes pl
        WHERE pl.passId = p.id
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pass_likes_on_like_change;
    `);
    await queryInterface.sequelize.query(`
      DROP TRIGGER IF EXISTS update_pass_likes_on_like_delete;
    `);
    await queryInterface.sequelize.query(`
      DROP PROCEDURE IF EXISTS recalculate_pass_likes_count;
    `);
    await queryInterface.dropTable('pass_likes');
    await queryInterface.removeColumn('passes', 'likes');
  },
};
