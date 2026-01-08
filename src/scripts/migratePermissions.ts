#!/usr/bin/env ts-node

import { Command } from 'commander';
import PermissionMigrationService from '../server/services/PermissionMigrationService.js';
import { logger } from '../server/services/LoggerService.js';
import { User } from '../models/index.js';
import Player from '../models/players/Player.js';
import { permissionFlags } from '../config/constants.js';

const program = new Command();

program
  .name('migrate-permissions')
  .description('Migrate user permissions from boolean flags to bit-based permission system')
  .version('1.0.0');

program
  .command('migrate')
  .description('Migrate all users to the new permission system')
  .option('-d, --dry-run', 'Run in dry-run mode (no database changes)', false)
  .action(async (options) => {
    try {
      logger.info('Starting permission migration script...');

      const migrationService = PermissionMigrationService.getInstance();
      const stats = await migrationService.migrateAllUsers(options.dryRun);

      console.log('\n=== Migration Results ===');
      console.log(`Total users: ${stats.totalUsers}`);
      console.log(`Migrated: ${stats.migratedUsers}`);
      console.log(`Skipped: ${stats.skippedUsers}`);
      console.log(`Errors: ${stats.errors.length}`);

      if (stats.errors.length > 0) {
        console.log('\n=== Errors ===');
        stats.errors.forEach(error => console.log(`- ${error}`));
      }

      if (Object.keys(stats.details).length > 0) {
        console.log('\n=== Migration Details ===');
        Object.entries(stats.details).forEach(([username, detail]) => {
          console.log(`\n${username}:`);
          console.log(`  Before: ${JSON.stringify(detail.before)}`);
          console.log(`  After: ${detail.after.permissionNames.join(', ')} (${detail.after.permissionFlags})`);
        });
      }

      process.exit(0);
    } catch (error) {
      logger.error('Migration script failed:', error);
      console.error('Migration failed:', error);
      process.exit(1);
    }
  });

program
  .command('verify')
  .description('Verify that all users have been properly migrated')
  .action(async () => {
    try {
      logger.info('Starting migration verification...');

      const migrationService = PermissionMigrationService.getInstance();
      const result = await migrationService.verifyMigration();

      console.log('\n=== Verification Results ===');
      console.log(`Valid: ${result.valid ? 'Yes' : 'No'}`);

      if (result.issues.length > 0) {
        console.log('\n=== Issues Found ===');
        result.issues.forEach(issue => console.log(`- ${issue}`));
      } else {
        console.log('All users have been properly migrated!');
      }

      process.exit(result.valid ? 0 : 1);
    } catch (error) {
      logger.error('Verification failed:', error);
      console.error('Verification failed:', error);
      process.exit(1);
    }
  });

program
  .command('migrate-user')
  .description('Migrate a specific user')
  .argument('<userId>', 'User ID to migrate')
  .option('-d, --dry-run', 'Run in dry-run mode (no database changes)', false)
  .action(async (userId, options) => {
    try {
      logger.info(`Starting migration for user ${userId}...`);

      const migrationService = PermissionMigrationService.getInstance();
      const result = await migrationService.migrateUser(userId, options.dryRun);

      if (result.success) {
        console.log('\n=== User Migration Results ===');
        console.log(`User ID: ${userId}`);
        console.log('Success: Yes');
        console.log(`Before: ${JSON.stringify(result.before)}`);
        console.log(`After: ${result.after?.permissionNames.join(', ')} (${result.after?.permissionFlags})`);
      } else {
        console.log('\n=== Migration Failed ===');
        console.log(`User ID: ${userId}`);
        console.log(`Error: ${result.error}`);
        process.exit(1);
      }

      process.exit(0);
    } catch (error) {
      logger.error('User migration failed:', error);
      console.error('User migration failed:', error);
      process.exit(1);
    }
  });

program
  .command('rollback')
  .description('Rollback migration by clearing all permission flags')
  .option('-d, --dry-run', 'Run in dry-run mode (no database changes)', false)
  .action(async (options) => {
    try {
      logger.info('Starting migration rollback...');

      const migrationService = PermissionMigrationService.getInstance();
      const result = await migrationService.rollbackMigration(options.dryRun);

      if (result.success) {
        console.log('\n=== Rollback Results ===');
        console.log('Success: Yes');
        console.log(`Affected users: ${result.affectedUsers}`);
      } else {
        console.log('\n=== Rollback Failed ===');
        console.log(`Error: ${result.error}`);
        process.exit(1);
      }

      process.exit(0);
    } catch (error) {
      logger.error('Rollback failed:', error);
      console.error('Rollback failed:', error);
      process.exit(1);
    }
  });

program
  .command('stats')
  .description('Show current permission statistics')
  .action(async () => {
    try {
      logger.info('Gathering permission statistics...');

             const users = await User.findAll();

             // Get all players for the users
      const playerIds = users.map(user => user.playerId).filter((id): id is number => id !== undefined);
      await Player.findAll({
        where: {
          id: playerIds
        }
      });

      const stats = {
        totalUsers: users.length,
        usersWithFlags: 0,
        usersWithoutFlags: 0,
        permissionCounts: {} as Record<string, number>,
        flagDistribution: {} as Record<string, number>
      };

             for (const user of users) {
         const userFlags = BigInt(user.permissionFlags || 0);
         if (userFlags !== 0n) {
          stats.usersWithFlags++;

                   // Count individual permissions
         Object.entries(permissionFlags).forEach(([name, flag]) => {
           const userFlags = BigInt(user.permissionFlags || 0);
           if ((userFlags & flag) === flag) {
             stats.permissionCounts[name] = (stats.permissionCounts[name] || 0) + 1;
           }
         });

                   // Count flag combinations
         const userFlags = BigInt(user.permissionFlags || 0);
         const flagKey = userFlags.toString();
         stats.flagDistribution[flagKey] = (stats.flagDistribution[flagKey] || 0) + 1;
        } else {
          stats.usersWithoutFlags++;
        }
      }

      console.log('\n=== Permission Statistics ===');
      console.log(`Total users: ${stats.totalUsers}`);
      console.log(`Users with permission flags: ${stats.usersWithFlags}`);
      console.log(`Users without permission flags: ${stats.usersWithoutFlags}`);
      console.log(`Migration progress: ${((stats.usersWithFlags / stats.totalUsers) * 100).toFixed(1)}%`);

      if (Object.keys(stats.permissionCounts).length > 0) {
        console.log('\n=== Permission Distribution ===');
        Object.entries(stats.permissionCounts)
          .sort(([,a], [,b]) => b - a)
          .forEach(([permission, count]) => {
            console.log(`${permission}: ${count} users`);
          });
      }

      if (Object.keys(stats.flagDistribution).length > 0) {
        console.log('\n=== Flag Combinations ===');
        Object.entries(stats.flagDistribution)
          .sort(([,a], [,b]) => b - a)
          .slice(0, 10) // Show top 10 combinations
          .forEach(([flags, count]) => {
            const permissionNames = Object.entries(permissionFlags)
              .filter(([, flag]) => (BigInt(flags) & flag) === flag)
              .map(([name]) => name);
            console.log(`${flags} (${permissionNames.join(', ')}): ${count} users`);
          });
      }

      process.exit(0);
    } catch (error) {
      logger.error('Statistics gathering failed:', error);
      console.error('Statistics gathering failed:', error);
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse();
