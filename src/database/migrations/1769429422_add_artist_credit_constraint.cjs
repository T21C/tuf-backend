'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // First, remove duplicate entries keeping only the first one (lowest id) for each songId+artistId combination
      // This handles the case where role is NULL and duplicates exist
      await queryInterface.sequelize.query(`
        DELETE sc1 FROM song_credits sc1
        INNER JOIN song_credits sc2 
        WHERE sc1.id > sc2.id 
        AND sc1.songId = sc2.songId 
        AND sc1.artistId = sc2.artistId
      `, { transaction });

      // Remove the old constraint that includes role (if it exists)
      // The original migration created it as an index, so we need to remove it as an index
      try {
        await queryInterface.removeIndex('song_credits', 'song_credits_songid_artistid_role_unique', { transaction });
      } catch (error) {
        // Index might not exist or have different name, try alternative name
        try {
          await queryInterface.removeIndex('song_credits', 'song_credits_songId_artistId_role_unique', { transaction });
        } catch (err) {
          // Constraint/index might not exist, continue
          console.log('Could not remove old constraint/index, may not exist:', err.message);
        }
      }

      // Add new unique constraint on just songId and artistId (without role)
      // This prevents an artist from being credited to the same song multiple times
      await queryInterface.addConstraint('song_credits', {
        type: 'UNIQUE',
        name: 'song_credits_songId_artistId_unique',
        fields: ['songId', 'artistId'],
        unique: true,
      }, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Remove the new constraint
      await queryInterface.removeConstraint('song_credits', 'song_credits_songId_artistId_unique', { transaction });

      // Restore the old constraint that includes role
      await queryInterface.addIndex('song_credits', {
        fields: ['songId', 'artistId', 'role'],
        unique: true,
        name: 'song_credits_songid_artistid_role_unique',
        transaction
      });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
