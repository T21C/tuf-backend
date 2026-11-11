'use strict';

/** @type {import('sequelize-cli').Migration} */

async function indexExists(sequelize, table, name) {
  const [rows] = await sequelize.query(
    `SHOW INDEX FROM \`${table}\` WHERE Key_name = :name`,
    {replacements: {name}},
  );
  return Array.isArray(rows) && rows.length > 0;
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const levelDesc = await queryInterface.describeTable('levels');
      if (!levelDesc.toCuration) {
        await queryInterface.addColumn(
          'levels',
          'toCuration',
          {
            type: Sequelize.BOOLEAN,
            allowNull: true,
            defaultValue: null,
          },
          {transaction},
        );
      }
      if (!levelDesc.curationRerateNum) {
        await queryInterface.addColumn(
          'levels',
          'curationRerateNum',
          {
            type: Sequelize.TEXT,
            allowNull: true,
          },
          {transaction},
        );
      }
      if (!levelDesc.curationRerateReason) {
        await queryInterface.addColumn(
          'levels',
          'curationRerateReason',
          {
            type: Sequelize.TEXT,
            allowNull: true,
          },
          {transaction},
        );
      }

      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('curation_ratings')) {
        await queryInterface.createTable(
          'curation_ratings',
          {
            id: {
              type: Sequelize.INTEGER,
              primaryKey: true,
              autoIncrement: true,
            },
            levelId: {
              type: Sequelize.INTEGER,
              allowNull: false,
              references: {model: 'levels', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            confirmedAt: {
              type: Sequelize.DATE,
              allowNull: true,
              defaultValue: null,
            },
            settledByUserId: {
              type: Sequelize.UUID,
              allowNull: true,
              defaultValue: null,
              references: {model: 'users', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'SET NULL',
            },
            createdAt: {
              type: Sequelize.DATE,
              allowNull: false,
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
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

      if (!names.includes('curation_rating_details')) {
        await queryInterface.createTable(
          'curation_rating_details',
          {
            id: {
              type: Sequelize.INTEGER,
              primaryKey: true,
              autoIncrement: true,
            },
            curationRatingId: {
              type: Sequelize.INTEGER,
              allowNull: false,
              references: {model: 'curation_ratings', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            userId: {
              type: Sequelize.UUID,
              allowNull: false,
              references: {model: 'users', key: 'id'},
              onUpdate: 'CASCADE',
              onDelete: 'CASCADE',
            },
            chartTypeId: {
              type: Sequelize.INTEGER,
              allowNull: true,
              defaultValue: null,
            },
            vfxTypeId: {
              type: Sequelize.INTEGER,
              allowNull: true,
              defaultValue: null,
            },
            miscTypeIds: {
              type: Sequelize.JSON,
              allowNull: false,
              defaultValue: Sequelize.literal("'[]'"),
            },
            comment: {
              type: Sequelize.TEXT,
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
              defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
            },
          },
          {transaction},
        );
        await queryInterface.addIndex(
          'curation_rating_details',
          ['curationRatingId', 'userId'],
          {unique: true, name: 'curation_rating_details_rating_user_unique', transaction},
        );
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }

    const sequelize = queryInterface.sequelize;
    const hasUnique = await indexExists(
      sequelize,
      'curation_ratings',
      'curation_ratings_one_open_per_level',
    );
    if (!hasUnique) {
      await sequelize.query(
        `ALTER TABLE curation_ratings
           ADD UNIQUE KEY curation_ratings_one_open_per_level ((IF(confirmedAt IS NULL, levelId, NULL)))`,
      );
    }
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const hasUnique = await indexExists(
      sequelize,
      'curation_ratings',
      'curation_ratings_one_open_per_level',
    );
    if (hasUnique) {
      await sequelize.query(
        `ALTER TABLE curation_ratings DROP INDEX curation_ratings_one_open_per_level`,
      );
    }

    const transaction = await sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));
      if (names.includes('curation_rating_details')) {
        await queryInterface.dropTable('curation_rating_details', {transaction});
      }
      if (names.includes('curation_ratings')) {
        await queryInterface.dropTable('curation_ratings', {transaction});
      }
      const levelDesc = await queryInterface.describeTable('levels');
      if (levelDesc.curationRerateReason) {
        await queryInterface.removeColumn('levels', 'curationRerateReason', {transaction});
      }
      if (levelDesc.curationRerateNum) {
        await queryInterface.removeColumn('levels', 'curationRerateNum', {transaction});
      }
      if (levelDesc.toCuration) {
        await queryInterface.removeColumn('levels', 'toCuration', {transaction});
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
