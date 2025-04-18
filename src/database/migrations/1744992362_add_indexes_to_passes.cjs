'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    try{
      await queryInterface.addIndex('passes', ['scoreV2', 'id']);
    } catch (error) {
      console.error('Error adding scoreV2 index to passes');
    }
    try{
      await queryInterface.addIndex('passes', ['isDeleted', 'id']);
    } catch (error) {
      console.error('Error adding isDeleted index to passes');
    }
    try{
      await queryInterface.addIndex('passes', ['levelId', 'id']);
    } catch (error) {
      console.error('Error adding levelId index to passes');
    }

  },

  async down(queryInterface, Sequelize) {   
    await queryInterface.removeIndex('passes', ['scoreV2', 'id']);
    await queryInterface.removeIndex('passes', ['isDeleted', 'id']);
    await queryInterface.removeIndex('passes', ['levelId', 'id']);
  }
}; 