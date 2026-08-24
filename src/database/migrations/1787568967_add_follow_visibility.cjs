'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('user_follows', 'isPublic', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
    await queryInterface.addColumn('users', 'publicFollows', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });

    await queryInterface.removeIndex('user_follows', 'user_follows_target_type_target_id');
    await queryInterface.addIndex(
      'user_follows',
      ['targetType', 'targetId', 'isPublic', 'createdAt'],
      {name: 'user_follows_target_type_target_id_is_public_created_at'},
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'user_follows',
      'user_follows_target_type_target_id_is_public_created_at',
    );
    await queryInterface.addIndex('user_follows', ['targetType', 'targetId'], {
      name: 'user_follows_target_type_target_id',
    });
    await queryInterface.removeColumn('users', 'publicFollows');
    await queryInterface.removeColumn('user_follows', 'isPublic');
  },
};
