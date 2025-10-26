'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {    
    // Simple unique index on non-nullable fields only
    // This prevents duplicates for matched difficulties
    await queryInterface.addIndex('level_rerate_histories', 
      [
        'levelId',
        'previousDiffId', 
        'newDiffId',
        'createdAt'
      ],
      {
        name: 'idx_rerate_unique_diff',
        unique: true
      }
    );

    // For legacy rerates, use COALESCE to handle NULLs
    // This creates a functional index that treats NULL as empty string
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX idx_rerate_unique_legacy 
      ON level_rerate_histories (
        levelId,
        oldLegacyValue,
        newLegacyValue,
        createdAt
      )
    `);
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('level_rerate_histories', 'idx_rerate_unique_diff');
    await queryInterface.removeIndex('level_rerate_histories', 'idx_rerate_unique_legacy');
  }
};