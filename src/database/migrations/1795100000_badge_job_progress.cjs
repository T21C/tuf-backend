'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('badge_jobs');
    const add = async (name, spec) => {
      if (!table[name]) await queryInterface.addColumn('badge_jobs', name, spec);
    };
    await add('processed', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await add('total', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await add('playerTotal', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await add('creatorTotal', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await add('playersProcessed', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await add('creatorsProcessed', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await add('definitionProgress', { type: Sequelize.JSON, allowNull: true });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('badge_jobs');
    for (const name of [
      'definitionProgress',
      'creatorsProcessed',
      'playersProcessed',
      'creatorTotal',
      'playerTotal',
      'total',
      'processed',
    ]) {
      if (table[name]) await queryInterface.removeColumn('badge_jobs', name);
    }
  },
};
