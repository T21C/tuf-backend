'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.addColumn(
        'users',
        'deletionScheduledAt',
        {
          type: Sequelize.DATE,
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'users',
        'deletionExecuteAt',
        {
          type: Sequelize.DATE,
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );

      await queryInterface.addColumn(
        'users',
        'deletionSnapshotPermissionFlags',
        {
          type: Sequelize.BIGINT,
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );

      await queryInterface.addIndex('users', ['deletionExecuteAt'], {
        name: 'users_deletion_execute_at_idx',
        transaction,
      });

      await queryInterface.addIndex('users', ['deletionScheduledAt'], {
        name: 'users_deletion_scheduled_at_idx',
        transaction,
      });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.removeIndex('users', 'users_deletion_execute_at_idx', {
        transaction,
      });
      await queryInterface.removeIndex('users', 'users_deletion_scheduled_at_idx', {
        transaction,
      });

      await queryInterface.removeColumn('users', 'deletionSnapshotPermissionFlags', {
        transaction,
      });
      await queryInterface.removeColumn('users', 'deletionExecuteAt', { transaction });
      await queryInterface.removeColumn('users', 'deletionScheduledAt', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};

