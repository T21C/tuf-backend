'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('level_requests')) {
        await queryInterface.createTable(
          'level_requests',
          {
            id: {
              type: Sequelize.INTEGER,
              primaryKey: true,
              autoIncrement: true,
              allowNull: false,
            },
            type: {type: Sequelize.STRING(32), allowNull: false},
            levelId: {
              type: Sequelize.INTEGER,
              allowNull: false,
              references: {model: 'levels', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            requesterUserId: {
              type: Sequelize.UUID,
              allowNull: false,
              references: {model: 'users', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            status: {type: Sequelize.STRING(32), allowNull: false, defaultValue: 'pending'},
            reason: {type: Sequelize.STRING(1000), allowNull: false, defaultValue: ''},
            publicNote: {type: Sequelize.TEXT, allowNull: true},
            internalNote: {type: Sequelize.TEXT, allowNull: true},
            payload: {type: Sequelize.JSON, allowNull: false},
            linkedRatingId: {
              type: Sequelize.INTEGER,
              allowNull: true,
              references: {model: 'ratings', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'SET NULL',
            },
            immediateSettle: {type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false},
            discordMessageUrl: {type: Sequelize.STRING(512), allowNull: true},
            discordPostError: {type: Sequelize.STRING(500), allowNull: true},
            resolvedAt: {type: Sequelize.DATE, allowNull: true},
            createdAt: {type: Sequelize.DATE, allowNull: false},
            updatedAt: {type: Sequelize.DATE, allowNull: false},
          },
          {transaction},
        );
        await queryInterface.addIndex('level_requests', ['levelId', 'type', 'status'], {
          name: 'level_requests_level_type_status',
          transaction,
        });
        await queryInterface.addIndex('level_requests', ['requesterUserId', 'createdAt'], {
          name: 'level_requests_requester_created',
          transaction,
        });
        await queryInterface.addIndex('level_requests', ['linkedRatingId'], {
          name: 'level_requests_linked_rating',
          transaction,
        });
        await queryInterface.addIndex('level_requests', ['status', 'createdAt'], {
          name: 'level_requests_status_created',
          transaction,
        });
      }

      const playerTable = await queryInterface.describeTable('players');
      if (!playerTable.rerateRequestBannedUntil) {
        await queryInterface.addColumn(
          'players',
          'rerateRequestBannedUntil',
          {
            type: Sequelize.DATE,
            allowNull: true,
            defaultValue: null,
          },
          {transaction},
        );
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));
      if (names.includes('level_requests')) {
        await queryInterface.dropTable('level_requests', {transaction});
      }
      const playerTable = await queryInterface.describeTable('players');
      if (playerTable.rerateRequestBannedUntil) {
        await queryInterface.removeColumn('players', 'rerateRequestBannedUntil', {transaction});
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
