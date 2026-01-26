'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Create artist_relations table for many-to-many relationships
      await queryInterface.createTable('artist_relations', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true
        },
        artistId1: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'artists',
            key: 'id'
          },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        },
        artistId2: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'artists',
            key: 'id'
          },
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE'
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      }, { transaction });

      // Add unique constraint to prevent duplicate relations (bidirectional)
      // Application logic ensures artistId1 < artistId2, so (artistId1, artistId2) and (artistId2, artistId1)
      // are treated as the same relation by always storing with the smaller ID first.
      // The unique constraint prevents duplicate (artistId1, artistId2) pairs.
      await queryInterface.addConstraint('artist_relations', {
        type: 'UNIQUE',
        name: 'artist_relations_unique_pair',
        fields: ['artistId1', 'artistId2'],
        unique: true,
      }, { transaction });

      // Add indexes for faster lookups
      await queryInterface.addIndex('artist_relations', ['artistId1'], { transaction });
      await queryInterface.addIndex('artist_relations', ['artistId2'], { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      
      await queryInterface.removeIndex('artist_relations', ['artistId2'], { transaction });
      await queryInterface.removeIndex('artist_relations', ['artistId1'], { transaction });
      await queryInterface.removeConstraint('artist_relations', 'artist_relations_unique_pair', { transaction });
      await queryInterface.dropTable('artist_relations', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
