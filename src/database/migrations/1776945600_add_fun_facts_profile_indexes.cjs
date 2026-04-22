'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('passes', ['playerId', 'isDeleted', 'isHidden'], {
      name: 'idx_passes_player_deleted_hidden',
    });

    await queryInterface.addIndex('level_credits', ['creatorId', 'role', 'levelId'], {
      name: 'idx_level_credits_creator_role_level',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('passes', 'idx_passes_player_deleted_hidden');
    await queryInterface.removeIndex('level_credits', 'idx_level_credits_creator_role_level');
  },
};
