'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.changeColumn(
        'profile_customization_pieces',
        'unit',
        {
          type: Sequelize.ENUM(
            'banner',
            'header_surface',
            'bio',
            'stellar_icon',
            'profile_modules',
          ),
          allowNull: false,
        },
        {transaction},
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
      await queryInterface.sequelize.query(
        "DELETE FROM profile_customization_pieces WHERE unit = 'profile_modules'",
        {transaction},
      );
      await queryInterface.changeColumn(
        'profile_customization_pieces',
        'unit',
        {
          type: Sequelize.ENUM('banner', 'header_surface', 'bio', 'stellar_icon'),
          allowNull: false,
        },
        {transaction},
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
