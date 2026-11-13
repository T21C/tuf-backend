'use strict';

/** @type {import('sequelize-cli').Migration} */

async function tableNames(queryInterface) {
  const tables = await queryInterface.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const levelDesc = await queryInterface.describeTable('levels');
      if (!levelDesc.curationFlow) {
        await queryInterface.addColumn(
          'levels',
          'curationFlow',
          {
            type: Sequelize.STRING(16),
            allowNull: true,
            defaultValue: null,
          },
          {transaction},
        );
      }

      const ratingDesc = await queryInterface.describeTable('curation_ratings');
      if (!ratingDesc.discordMessageUrl) {
        await queryInterface.addColumn(
          'curation_ratings',
          'discordMessageUrl',
          {
            type: Sequelize.STRING(512),
            allowNull: true,
          },
          {transaction},
        );
      }
      if (!ratingDesc.discordPostError) {
        await queryInterface.addColumn(
          'curation_ratings',
          'discordPostError',
          {
            type: Sequelize.TEXT,
            allowNull: true,
          },
          {transaction},
        );
      }
      if (!ratingDesc.discordThreadClosed) {
        await queryInterface.addColumn(
          'curation_ratings',
          'discordThreadClosed',
          {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          {transaction},
        );
      }

      const names = await tableNames(queryInterface);
      if (!names.includes('curation_announcement_queue')) {
        await queryInterface.createTable(
          'curation_announcement_queue',
          {
            id: {
              type: Sequelize.INTEGER,
              autoIncrement: true,
              primaryKey: true,
            },
            levelId: {
              type: Sequelize.INTEGER,
              allowNull: false,
              references: {model: 'levels', key: 'id'},
              onDelete: 'CASCADE',
              onUpdate: 'CASCADE',
            },
            kind: {
              type: Sequelize.ENUM('NEW', 'RERATE'),
              allowNull: false,
            },
            beforeTypeIds: {
              type: Sequelize.JSON,
              allowNull: false,
              defaultValue: Sequelize.literal("'[]'"),
            },
            afterTypeIds: {
              type: Sequelize.JSON,
              allowNull: false,
              defaultValue: Sequelize.literal("'[]'"),
            },
            status: {
              type: Sequelize.ENUM('PENDING', 'ANNOUNCED', 'SKIPPED'),
              allowNull: false,
              defaultValue: 'PENDING',
            },
            pendingUniqueKey: {
              type: Sequelize.INTEGER,
              allowNull: true,
            },
            enqueuedBy: {
              type: Sequelize.UUID,
              allowNull: true,
              references: {model: 'users', key: 'id'},
              onDelete: 'SET NULL',
              onUpdate: 'CASCADE',
            },
            announcedAt: {
              type: Sequelize.DATE,
              allowNull: true,
            },
            createdAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
            updatedAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal(
                'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
              ),
            },
          },
          {transaction},
        );
        await queryInterface.addIndex('curation_announcement_queue', ['levelId'], {
          name: 'idx_curation_announcement_queue_level_id',
          transaction,
        });
        await queryInterface.addIndex('curation_announcement_queue', ['kind', 'status'], {
          name: 'idx_curation_announcement_queue_kind_status',
          transaction,
        });
        await queryInterface.addConstraint('curation_announcement_queue', {
          fields: ['pendingUniqueKey'],
          type: 'unique',
          name: 'uniq_curation_announcement_queue_pending_level',
          transaction,
        });
      }

      if (!names.includes('zen_curation_sessions')) {
        await queryInterface.createTable(
          'zen_curation_sessions',
          {
            userId: {
              type: Sequelize.UUID,
              allowNull: false,
              primaryKey: true,
              references: {model: 'users', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            payload: {
              type: Sequelize.JSON,
              allowNull: false,
            },
            updatedAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
          },
          {transaction},
        );
      }

      await queryInterface.sequelize.query(
        `UPDATE levels
           SET curationFlow = CASE
             WHEN EXISTS (SELECT 1 FROM curations c WHERE c.levelId = levels.id) THEN 'rerate'
             ELSE 'recent'
           END
         WHERE toCuration = 1 AND (curationFlow IS NULL OR curationFlow = '')`,
        {transaction},
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
      const names = await tableNames(queryInterface);
      if (names.includes('zen_curation_sessions')) {
        await queryInterface.dropTable('zen_curation_sessions', {transaction});
      }
      if (names.includes('curation_announcement_queue')) {
        await queryInterface.dropTable('curation_announcement_queue', {transaction});
      }
      const ratingDesc = await queryInterface.describeTable('curation_ratings');
      if (ratingDesc.discordThreadClosed) {
        await queryInterface.removeColumn('curation_ratings', 'discordThreadClosed', {transaction});
      }
      if (ratingDesc.discordPostError) {
        await queryInterface.removeColumn('curation_ratings', 'discordPostError', {transaction});
      }
      if (ratingDesc.discordMessageUrl) {
        await queryInterface.removeColumn('curation_ratings', 'discordMessageUrl', {transaction});
      }
      const levelDesc = await queryInterface.describeTable('levels');
      if (levelDesc.curationFlow) {
        await queryInterface.removeColumn('levels', 'curationFlow', {transaction});
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
