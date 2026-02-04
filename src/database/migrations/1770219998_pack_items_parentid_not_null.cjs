'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Step 1: Remove the foreign key constraint FIRST (before updating values)
    // This constraint prevents setting parentId to 0 since there's no row with id=0
    // We're changing parentId=0 to mean "root level" instead of a foreign key reference
    try {
      await queryInterface.removeConstraint('level_pack_items', 'level_pack_items_ibfk_2');
      console.log('Removed foreign key constraint level_pack_items_ibfk_2');
    } catch (e) {
      // Try alternative constraint name
      try {
        await queryInterface.removeConstraint('level_pack_items', 'level_pack_items_parentId_fkey');
        console.log('Removed foreign key constraint level_pack_items_parentId_fkey');
      } catch (e2) {
        // If both fail, try to find and drop via raw SQL
        console.log('Attempting to find and drop foreign key constraint via raw SQL...');
        const [constraints] = await queryInterface.sequelize.query(`
          SELECT CONSTRAINT_NAME 
          FROM information_schema.KEY_COLUMN_USAGE 
          WHERE TABLE_SCHEMA = DATABASE() 
            AND TABLE_NAME = 'level_pack_items' 
            AND COLUMN_NAME = 'parentId' 
            AND REFERENCED_TABLE_NAME IS NOT NULL
        `);
        
        for (const constraint of constraints) {
          await queryInterface.sequelize.query(
            `ALTER TABLE level_pack_items DROP FOREIGN KEY \`${constraint.CONSTRAINT_NAME}\``
          );
          console.log(`Removed foreign key constraint ${constraint.CONSTRAINT_NAME}`);
        }
      }
    }

    // Step 2: Update existing NULL parentId values to 0 (root level)
    await queryInterface.sequelize.query(
      'UPDATE level_pack_items SET parentId = 0 WHERE parentId IS NULL'
    );

    // Step 3: Change parentId column to NOT NULL with default 0
    await queryInterface.changeColumn('level_pack_items', 'parentId', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Parent item ID for tree structure within pack (0 = root level)',
    });

    // Step 4: Add unique constraint to prevent duplicate levels in the same folder
    // This prevents race conditions from concurrent requests
    await queryInterface.addIndex('level_pack_items', ['packId', 'parentId', 'levelId'], {
      name: 'level_pack_items_pack_parent_level_unique',
      unique: true,
    });
  },

  async down(queryInterface, Sequelize) {
    // Remove the unique constraint
    await queryInterface.removeIndex('level_pack_items', 'level_pack_items_pack_parent_level_unique');

    // Convert 0 back to NULL for root level items (before adding constraint)
    await queryInterface.sequelize.query(
      'UPDATE level_pack_items SET parentId = NULL WHERE parentId = 0'
    );

    // Change parentId back to nullable
    await queryInterface.changeColumn('level_pack_items', 'parentId', {
      type: Sequelize.INTEGER,
      allowNull: true,
      comment: 'Parent item ID for tree structure within pack (null = root level)',
    });

    // Re-add the foreign key constraint
    await queryInterface.sequelize.query(`
      ALTER TABLE level_pack_items 
      ADD CONSTRAINT level_pack_items_ibfk_2 
      FOREIGN KEY (parentId) REFERENCES level_pack_items(id) 
      ON DELETE CASCADE ON UPDATE CASCADE
    `);
  }
};
