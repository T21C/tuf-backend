'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const transaction = await queryInterface.sequelize.transaction();

    try {
      if (!tables.includes('player_leaderboard_rank_events')) {
        await queryInterface.createTable(
          'player_leaderboard_rank_events',
          {
            id: {
              type: Sequelize.BIGINT.UNSIGNED,
              autoIncrement: true,
              primaryKey: true,
              allowNull: false,
            },
            playerId: {
              type: Sequelize.INTEGER,
              allowNull: false,
              references: { model: 'players', key: 'id' },
              onDelete: 'CASCADE',
              onUpdate: 'CASCADE',
            },
            scoringVersion: {
              type: Sequelize.STRING(64),
              allowNull: false,
            },
            effectiveDay: {
              type: Sequelize.DATEONLY,
              allowNull: false,
              comment: 'UTC calendar date; ranks are as-of end of this day (see backfill/cron cutoff)',
            },
            rankedScoreRank: {
              type: Sequelize.INTEGER,
              allowNull: false,
              comment: '-1 = not on leaderboard (e.g. dropped off); otherwise 1-based competition rank',
            },
            generalScoreRank: {
              type: Sequelize.INTEGER,
              allowNull: false,
            }
          },
          { transaction },
        );

        await queryInterface.addIndex(
          'player_leaderboard_rank_events',
          ['scoringVersion', 'playerId', 'effectiveDay'],
          {
            name: 'idx_plre_version_player_day',
            unique: true,
            transaction,
          },
        );

        await queryInterface.addIndex(
          'player_leaderboard_rank_events',
          ['playerId', 'scoringVersion', 'effectiveDay'],
          {
            name: 'idx_plre_player_version_day',
            transaction,
          },
        );
      }

      if (!tables.includes('leaderboard_rank_backfill_checkpoint')) {
        await queryInterface.createTable(
          'leaderboard_rank_backfill_checkpoint',
          {
            scoringVersion: {
              type: Sequelize.STRING(64),
              primaryKey: true,
              allowNull: false,
            },
            lastCompletedEffectiveDay: {
              type: Sequelize.DATEONLY,
              allowNull: true,
            },
            updatedAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
            },
          },
          { transaction },
        );
      }

      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('player_leaderboard_rank_events');
    await queryInterface.dropTable('leaderboard_rank_backfill_checkpoint');
  },
};
