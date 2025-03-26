'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.createTable(
        'directive_condition_history',
        {
          id: {
            type: Sequelize.INTEGER,
            primaryKey: true,
            autoIncrement: true,
            allowNull: false,
          },
          directiveId: {
            type: Sequelize.INTEGER,
            allowNull: false,
            references: {
              model: 'announcement_directives',
              key: 'id',
            },
            onDelete: 'CASCADE',
          },
          conditionHash: {
            type: Sequelize.STRING,
            allowNull: false,
            comment: 'Hash of the condition parameters to uniquely identify this condition',
          },
          createdAt: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          },
          updatedAt: {
            type: Sequelize.DATE,
            allowNull: false,
            defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
          },
        },
        { transaction }
      );

      // Add indexes for better query performance
      await queryInterface.addIndex(
        'directive_condition_history',
        ['directiveId', 'conditionHash'],
        {
          unique: true,
          transaction,
        }
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.dropTable('directive_condition_history', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
}; 