'use strict';

const SEED = [
  {slug: 'full', name: '100%', sortOrder: 0},
  {slug: 'tkl', name: 'TKL', sortOrder: 1},
  {slug: '96', name: '96%', sortOrder: 2},
  {slug: '75', name: '75%', sortOrder: 3},
  {slug: '65', name: '65%', sortOrder: 4},
  {slug: 'other', name: 'Other', sortOrder: 5},
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('keyboard_geometries', 'formFactor', {
      type: Sequelize.STRING(32),
      allowNull: false,
    });
    await queryInterface.createTable('keyboard_form_factors', {
      slug: {type: Sequelize.STRING(32), allowNull: false, primaryKey: true},
      name: {type: Sequelize.STRING(64), allowNull: false},
      note: {type: Sequelize.STRING(500), allowNull: true},
      sortOrder: {type: Sequelize.INTEGER, allowNull: false, defaultValue: 0},
      createdAt: {type: Sequelize.DATE, allowNull: false},
      updatedAt: {type: Sequelize.DATE, allowNull: false},
    });
    const now = new Date();
    await queryInterface.bulkInsert(
      'keyboard_form_factors',
      SEED.map((row) => ({...row, note: null, createdAt: now, updatedAt: now})),
    );
    await queryInterface.addConstraint('keyboard_geometries', {
      fields: ['formFactor'],
      type: 'foreign key',
      name: 'fk_keyboard_geometries_form_factor',
      references: {table: 'keyboard_form_factors', field: 'slug'},
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeConstraint(
      'keyboard_geometries',
      'fk_keyboard_geometries_form_factor',
    );
    await queryInterface.dropTable('keyboard_form_factors');
    await queryInterface.changeColumn('keyboard_geometries', 'formFactor', {
      type: Sequelize.ENUM('full', 'tkl', '96', '75', '65', 'other'),
      allowNull: false,
    });
  },
};
