'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'ratings',
        'settledDiffId',
        {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'difficulties', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'ratings',
        'clearsAtSettle',
        {
          type: Sequelize.INTEGER,
          allowNull: true,
        },
        { transaction },
      );
      await queryInterface.addIndex('ratings', ['settledDiffId'], {
        name: 'ratings_settled_diff_id',
        transaction,
      });

      await queryInterface.createTable(
        'rating_accuracy_samples',
        {
          ratingDetailId: {
            type: Sequelize.INTEGER,
            allowNull: false,
            primaryKey: true,
            references: { model: 'rating_details', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          ratingId: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: { model: 'ratings', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          userId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: 'users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          isCommunityRating: {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          track: {
            type: Sequelize.STRING(16),
            allowNull: false,
          },
          scoringMode: {
            type: Sequelize.STRING(16),
            allowNull: false,
          },
          frozenRating: {
            type: Sequelize.STRING(255),
            allowNull: false,
          },
          settledDiffId: {
            type: Sequelize.INTEGER,
            allowNull: true,
            references: { model: 'difficulties', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          clearsAtSettle: {
            type: Sequelize.INTEGER,
            allowNull: true,
          },
          score: {
            type: Sequelize.DOUBLE,
            allowNull: true,
          },
          chart: {
            type: Sequelize.JSON,
            allowNull: true,
          },
          createdAt: {
            type: Sequelize.DATE,
            allowNull: false,
          },
          updatedAt: {
            type: Sequelize.DATE,
            allowNull: false,
          },
        },
        { transaction },
      );
      await queryInterface.addIndex('rating_accuracy_samples', ['userId', 'isCommunityRating'], {
        name: 'rating_accuracy_samples_user_community',
        transaction,
      });
      await queryInterface.addIndex('rating_accuracy_samples', ['ratingId'], {
        name: 'rating_accuracy_samples_rating_id',
        transaction,
      });

      await queryInterface.createTable(
        'rating_accuracy_stats',
        {
          userId: {
            type: Sequelize.UUID,
            allowNull: false,
            primaryKey: true,
            references: { model: 'users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE',
          },
          isCommunityRating: {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            primaryKey: true,
            defaultValue: false,
          },
          pguRawMean: {
            type: Sequelize.DOUBLE,
            allowNull: false,
            defaultValue: 0,
          },
          pguN: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          pguShrunkMean: {
            type: Sequelize.DOUBLE,
            allowNull: false,
            defaultValue: 0.5,
          },
          specialRawMean: {
            type: Sequelize.DOUBLE,
            allowNull: false,
            defaultValue: 0,
          },
          specialN: {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 0,
          },
          createdAt: {
            type: Sequelize.DATE,
            allowNull: false,
          },
          updatedAt: {
            type: Sequelize.DATE,
            allowNull: false,
          },
        },
        { transaction },
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.dropTable('rating_accuracy_stats', { transaction });
      await queryInterface.dropTable('rating_accuracy_samples', { transaction });
      await queryInterface.removeIndex('ratings', 'ratings_settled_diff_id', { transaction }).catch(() => {});
      await queryInterface.removeColumn('ratings', 'clearsAtSettle', { transaction });
      await queryInterface.removeColumn('ratings', 'settledDiffId', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
