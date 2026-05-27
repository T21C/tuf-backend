'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('audit_logs', ['createdAt'], {
      name: 'idx_audit_logs_created_at',
    });
    await queryInterface.addIndex('audit_logs', ['updatedAt'], {
      name: 'idx_audit_logs_updated_at',
    });
    await queryInterface.addIndex('audit_logs', ['userId', 'createdAt'], {
      name: 'idx_audit_logs_user_created_at',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('audit_logs', 'idx_audit_logs_created_at');
    await queryInterface.removeIndex('audit_logs', 'idx_audit_logs_updated_at');
    await queryInterface.removeIndex('audit_logs', 'idx_audit_logs_user_created_at');
  },
};
