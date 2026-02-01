'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Remove the unique constraint on discordGuildId + roleId
      // This allows multiple assignment rules for the same roleId in the same guild
      
      // Try multiple approaches to remove the unique index/constraint
      // Sequelize auto-generates names, so we need to try different formats
      const indexNames = [
        'discord_sync_roles_discord_guild_id_role_id',
      ];

      let removed = false;
      for (const indexName of indexNames) {
        try {
          await queryInterface.removeIndex('discord_sync_roles', indexName, { transaction });
          removed = true;
          console.log(`Successfully removed index: ${indexName}`);
          break;
        } catch (error) {
          // Try next name
          continue;
        }
      }

      // If removeIndex didn't work, try removeConstraint
      if (!removed) {
        for (const constraintName of indexNames) {
          try {
            await queryInterface.removeConstraint('discord_sync_roles', constraintName, { transaction });
            removed = true;
            console.log(`Successfully removed constraint: ${constraintName}`);
            break;
          } catch (error) {
            // Try next name
            continue;
          }
        }
      }

      // Add a non-unique index for performance (still need index for queries)
      // Only add if we successfully removed the unique one
      if (removed) {
        try {
          await queryInterface.addIndex('discord_sync_roles', ['discordGuildId', 'roleId'], {
            name: 'discord_sync_roles_guild_role_idx',
            unique: false,
            transaction
          });
          console.log('Successfully added non-unique index');
        } catch (error) {
          console.log('Could not add non-unique index, may already exist:', error.message);
        }
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Remove the non-unique index first
      try {
        await queryInterface.removeIndex('discord_sync_roles', 'discord_sync_roles_guild_role_idx', { transaction });
      } catch (error) {
        console.log('Could not remove non-unique index:', error.message);
      }

      // Re-add the unique constraint
      await queryInterface.addIndex('discord_sync_roles', ['discordGuildId', 'roleId'], {
        unique: true,
        name: 'discord_sync_roles_discord_guild_id_role_id',
        transaction
      });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
