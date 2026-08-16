'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('pass_submissions', ['userId', 'createdAt'], {
      name: 'idx_pass_submissions_user_created_at',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('pass_submissions', 'idx_pass_submissions_user_created_at');
  },
};
