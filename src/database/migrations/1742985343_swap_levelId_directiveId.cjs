'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // First, add the new levelId column without constraints
      await queryInterface.addColumn('directive_condition_history', 'levelId', {
        type: Sequelize.INTEGER,
        allowNull: true, // Allow null initially
      }, { transaction });

      // Now add the foreign key constraint
      await queryInterface.changeColumn('directive_condition_history', 'levelId', {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'levels',
          key: 'id',
        },
      }, { transaction });

      // Remove the foreign key constraint from directiveId first
      await queryInterface.removeConstraint('directive_condition_history', 'directive_condition_history_directiveId_fkey', { transaction });

      // Now we can safely update the unique index
      await queryInterface.removeIndex('directive_condition_history', ['directiveId', 'conditionHash'], { transaction });
      await queryInterface.addIndex('directive_condition_history', ['levelId', 'conditionHash'], {
        unique: true,
        transaction
      });

      // Finally, remove the old directiveId column
      await queryInterface.removeColumn('directive_condition_history', 'directiveId', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Add back directiveId column without constraints
      await queryInterface.addColumn('directive_condition_history', 'directiveId', {
        type: Sequelize.INTEGER,
        allowNull: true, // Allow null initially
      }, { transaction });

      // Copy data back from levels to announcement_directives
      await queryInterface.sequelize.query(`
        UPDATE directive_condition_history dch
        JOIN levels l ON dch.levelId = l.id
        JOIN announcement_directives ad ON l.difficultyId = ad.difficultyId
        SET dch.directiveId = ad.id
      `, { transaction });

      // Add back the foreign key constraint
      await queryInterface.changeColumn('directive_condition_history', 'directiveId', {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'announcement_directives',
          key: 'id',
        },
      }, { transaction });

      // Revert the unique index
      await queryInterface.removeIndex('directive_condition_history', ['levelId', 'conditionHash'], { transaction });
      await queryInterface.addIndex('directive_condition_history', ['directiveId', 'conditionHash'], {
        unique: true,
        transaction
      });

      // Remove the levelId column
      await queryInterface.removeColumn('directive_condition_history', 'levelId', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};