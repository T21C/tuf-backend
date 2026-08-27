'use strict';

/**
 * All current tag assignments were staff-placed. Pin them so community
 * rematerialize cannot drop them after tags are switched to community/skillset.
 * New vote-won assignments stay unpinned via the column default.
 */

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(
        `UPDATE level_tag_assignments
         SET pinned = 1
         WHERE pinned = 0`,
        { transaction },
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down() {
    // Original pin flags are not stored; do not unpin every row on rollback.
  },
};
