'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Create pack_folders table
      try {
      await queryInterface.createTable('pack_folders', {
        id: {
          type: Sequelize.INTEGER,
          autoIncrement: true,
          primaryKey: true,
          allowNull: false,
        },
        ownerId: {
          type: Sequelize.UUID,
          allowNull: false,
          references: {
            model: 'users',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        name: {
          type: Sequelize.STRING,
          allowNull: false,
          comment: 'Folder name',
        },
        parentFolderId: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: {
            model: 'pack_folders',
            key: 'id',
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
          comment: 'Parent folder ID for nested folders',
        },
        sortOrder: {
          type: Sequelize.INTEGER,
          allowNull: false,
          defaultValue: 0,
          comment: 'Sort order within parent folder',
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
      }, { transaction });
      }
      catch(error){
        console.log(error);
      }

      await queryInterface.renameTable('levelpacks', 'level_packs', { transaction });
      await queryInterface.renameTable('levelpackitems', 'level_pack_items', { transaction });
      // Add folderId column to level_packs table
      await queryInterface.addColumn('level_packs', 'folderId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'pack_folders',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Folder containing this pack',
      }, { transaction });

      // Add sortOrder column to level_packs table for ordering within folders
      await queryInterface.addColumn('level_packs', 'sortOrder', {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Sort order within folder',
      }, { transaction });

      // Add indexes for better performance
      await queryInterface.addIndex('pack_folders', ['ownerId'], {
        transaction,
      });

      await queryInterface.addIndex('pack_folders', ['parentFolderId'], {
        transaction,
      });

      await queryInterface.addIndex('pack_folders', ['ownerId', 'parentFolderId', 'sortOrder'], {
        name: 'pack_folders_owner_parent_sort',
        transaction,
      });

      await queryInterface.addIndex('level_packs', ['folderId'], {
        transaction,
      });

      await queryInterface.addIndex('level_packs', ['folderId', 'sortOrder'], {
        name: 'level_packs_folder_sort',
        transaction,
      });

      // Add unique constraint to prevent duplicate folder names within the same parent
      await queryInterface.addConstraint('pack_folders', {
        fields: ['ownerId', 'parentFolderId', 'name'],
        type: 'unique',
        name: 'unique_folder_name_per_parent',
        transaction,
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
      // Remove constraints and indexes
      await queryInterface.removeConstraint('pack_folders', 'unique_folder_name_per_parent', { transaction });
      await queryInterface.renameTable('level_packs', 'levelpacks', { transaction });
      await queryInterface.renameTable('level_pack_items', 'levelpackitems', { transaction });
      await queryInterface.removeIndex('level_packs', 'level_packs_folder_sort', { transaction });
      await queryInterface.removeIndex('level_packs', ['folderId'], { transaction });
      await queryInterface.removeIndex('pack_folders', 'pack_folders_owner_parent_sort', { transaction });
      await queryInterface.removeIndex('pack_folders', ['parentFolderId'], { transaction });
      await queryInterface.removeIndex('pack_folders', ['ownerId'], { transaction });

      // Remove columns from level_packs
      await queryInterface.removeColumn('level_packs', 'sortOrder', { transaction });
      await queryInterface.removeColumn('level_packs', 'folderId', { transaction });

      // Drop pack_folders table
      await queryInterface.dropTable('pack_folders', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },
};
