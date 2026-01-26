'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Create a view that provides bidirectional access to artist relations
      // This view swaps columns so we can query relations from either direction
      await queryInterface.sequelize.query(`
        CREATE VIEW artist_relations_bidirectional AS
        SELECT 
          id,
          artistId1 AS artistId,
          artistId2 AS relatedArtistId,
          createdAt,
          updatedAt
        FROM artist_relations
        UNION ALL
        SELECT 
          id,
          artistId2 AS artistId,
          artistId1 AS relatedArtistId,
          createdAt,
          updatedAt
        FROM artist_relations
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.sequelize.query('DROP VIEW IF EXISTS artist_relations_bidirectional', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
