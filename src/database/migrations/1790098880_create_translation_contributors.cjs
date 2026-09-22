'use strict';

/** Names previously hardcoded or stored as languages.contributorNames. */
const SEEDED_CONTRIBUTORS = {
  pl: ['Matsum'],
  kr: ['부담토끼', 'van-ci', 'HaeengIn', '동찬토끼'],
  cn: ['Alex1044', 'Desktop-0114514', '和九酱'],
  fr: ['Folcrome', 'Dexical'],
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tables = await queryInterface.showAllTables();
      const names = tables.map((t) => (typeof t === 'string' ? t : t.tableName || t.name));

      if (!names.includes('translation_contributors')) {
        await queryInterface.createTable(
          'translation_contributors',
          {
            id: {
              type: Sequelize.INTEGER,
              autoIncrement: true,
              primaryKey: true,
              allowNull: false,
            },
            languageCode: {
              type: Sequelize.STRING(16),
              allowNull: false,
            },
            name: {
              type: Sequelize.STRING(80),
              allowNull: false,
            },
            sortOrder: {
              type: Sequelize.INTEGER,
              allowNull: false,
              defaultValue: 0,
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
          'translation_contributors',
          ['languageCode', 'sortOrder'],
          {
            name: 'idx_translation_contributors_language_sort',
            transaction,
          },
        );

        const now = new Date();
        const rows = [];
        for (const [languageCode, contributorNames] of Object.entries(SEEDED_CONTRIBUTORS)) {
          contributorNames.forEach((name, sortOrder) => {
            rows.push({
              languageCode,
              name,
              sortOrder,
              createdAt: now,
              updatedAt: now,
            });
          });
        }

        if (rows.length > 0) {
          await queryInterface.bulkInsert('translation_contributors', rows, {transaction});
        }
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
      if (names.includes('translation_contributors')) {
        await queryInterface.dropTable('translation_contributors', {transaction});
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
