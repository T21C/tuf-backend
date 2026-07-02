'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable(
        'tuf_stellar_admin_grants',
        {
          id: {
            type: Sequelize.BIGINT.UNSIGNED,
            autoIncrement: true,
            primaryKey: true,
            allowNull: false,
          },
          grantedByUserId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: 'users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          beneficiaryUserId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: 'users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          durationKind: {
            type: Sequelize.ENUM('months', 'days'),
            allowNull: false,
          },
          durationValue: {
            type: Sequelize.INTEGER.UNSIGNED,
            allowNull: false,
          },
          startsAt: {
            type: Sequelize.DATE(6),
            allowNull: false,
          },
          endsAt: {
            type: Sequelize.DATE(6),
            allowNull: false,
          },
          segmentId: {
            type: Sequelize.BIGINT.UNSIGNED,
            allowNull: true,
            defaultValue: null,
            references: { model: 'user_tuf_stellar_entitlement_segments', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          note: {
            type: Sequelize.STRING(255),
            allowNull: true,
            defaultValue: null,
          },
          status: {
            type: Sequelize.ENUM('active', 'retracted'),
            allowNull: false,
            defaultValue: 'active',
          },
          retractedByUserId: {
            type: Sequelize.UUID,
            allowNull: true,
            defaultValue: null,
            references: { model: 'users', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL',
          },
          retractedAt: {
            type: Sequelize.DATE(6),
            allowNull: true,
            defaultValue: null,
          },
          createdAt: {
            type: Sequelize.DATE(6),
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(6)'),
          },
        },
        { transaction },
      );

      await queryInterface.addIndex('tuf_stellar_admin_grants', ['beneficiaryUserId'], {
        name: 'idx_tuf_stellar_admin_grants_beneficiary',
        transaction,
      });
      await queryInterface.addIndex('tuf_stellar_admin_grants', ['grantedByUserId'], {
        name: 'idx_tuf_stellar_admin_grants_granted_by',
        transaction,
      });
      await queryInterface.addIndex('tuf_stellar_admin_grants', ['endsAt'], {
        name: 'idx_tuf_stellar_admin_grants_ends_at',
        transaction,
      });
      await queryInterface.addIndex('tuf_stellar_admin_grants', ['createdAt'], {
        name: 'idx_tuf_stellar_admin_grants_created_at',
        transaction,
      });

      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('tuf_stellar_admin_grants');
  },
};
