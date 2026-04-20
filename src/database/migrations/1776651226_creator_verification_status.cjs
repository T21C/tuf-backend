'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      const tableInfo = await queryInterface.describeTable('creators');

      if (!tableInfo.verificationStatus) {
        await queryInterface.addColumn(
          'creators',
          'verificationStatus',
          {
            type: Sequelize.ENUM('declined', 'pending', 'conditional', 'allowed'),
            allowNull: false,
            defaultValue: 'declined',
          },
          { transaction },
        );

        await queryInterface.addIndex('creators', ['verificationStatus'], {
          name: 'creators_verification_status_idx',
          transaction,
        });
      }

      if (tableInfo.isVerified) {
        await queryInterface.removeColumn('creators', 'isVerified', { transaction });
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      const tableInfo = await queryInterface.describeTable('creators');

      if (!tableInfo.isVerified) {
        await queryInterface.addColumn(
          'creators',
          'isVerified',
          {
            type: Sequelize.BOOLEAN,
            allowNull: false,
            defaultValue: false,
          },
          { transaction },
        );
      }

      if (tableInfo.verificationStatus) {
        await queryInterface.removeIndex('creators', 'creators_verification_status_idx', { transaction });
        await queryInterface.removeColumn('creators', 'verificationStatus', { transaction });
        await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_creators_verificationStatus";', { transaction });
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
