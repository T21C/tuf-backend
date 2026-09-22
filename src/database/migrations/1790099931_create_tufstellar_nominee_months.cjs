'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.createTable(
        'tufstellar_nominee_months',
        {
          id: {
            type: Sequelize.BIGINT.UNSIGNED,
            autoIncrement: true,
            primaryKey: true,
            allowNull: false,
          },
          userId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: {model: 'users', key: 'id'},
            onUpdate: 'CASCADE',
            onDelete: 'RESTRICT',
          },
          monthKey: {
            type: Sequelize.STRING(7),
            allowNull: false,
          },
          createdAt: {
            type: Sequelize.DATE(6),
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(6)'),
          },
        },
        {transaction},
      );

      await queryInterface.addConstraint('tufstellar_nominee_months', {
        fields: ['userId', 'monthKey'],
        type: 'unique',
        name: 'uniq_tufstellar_nominee_months_user_month',
        transaction,
      });

      await transaction.commit();
    } catch (e) {
      await transaction.rollback();
      throw e;
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('tufstellar_nominee_months');
  },
};
