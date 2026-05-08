'use strict';

/** TUFStellar subscription tracking + GIF avatar marker for static/animated CDN presentation. */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'users',
        'tufStellarSubscriptionExpiresAt',
        {
          type: Sequelize.DATE,
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'users',
        'tufStellarSubscriptionExternalId',
        {
          type: Sequelize.STRING(191),
          allowNull: true,
          defaultValue: null,
        },
        { transaction },
      );
      await queryInterface.addColumn(
        'users',
        'avatarIsGif',
        {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        { transaction },
      );
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeColumn('users', 'avatarIsGif', { transaction });
      await queryInterface.removeColumn('users', 'tufStellarSubscriptionExternalId', { transaction });
      await queryInterface.removeColumn('users', 'tufStellarSubscriptionExpiresAt', { transaction });
      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },
};
