'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      try{
        await queryInterface.dropTable('player_modifiers', { transaction });
      }
      catch(error){
        console.log(error);
      }
      await queryInterface.createTable('player_modifiers', {
        id: {
          type: Sequelize.INTEGER,
          primaryKey: true,
          autoIncrement: true
        },
        playerId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'players',
            key: 'id'
          },
          onDelete: 'CASCADE'
        },
        type: {
          type: Sequelize.STRING,
          allowNull: false
        },
        value: {
          type: Sequelize.FLOAT,
          allowNull: true
        },
        expiresAt: {
          type: Sequelize.DATE,
          allowNull: false
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }, { transaction });

      await queryInterface.addIndex('player_modifiers', ['playerId', 'type'], {
        transaction
      });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.dropTable('player_modifiers', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
}; 