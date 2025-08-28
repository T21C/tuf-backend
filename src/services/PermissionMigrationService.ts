import { Op, Transaction } from 'sequelize';
import sequelize from '../config/db.js';
import User from '../models/auth/User.js';
import Player from '../models/players/Player.js';
import { permissionFlags } from '../config/constants.js';
import { logger } from './LoggerService.js';

// Add BigInt serialization support
const originalStringify = JSON.stringify;
JSON.stringify = function(value: any, replacer?: any, space?: any) {
  const customReplacer = (key: string, val: any) => {
    if (typeof val === 'bigint') {
      return val.toString();
    }
    return replacer && typeof replacer === 'function' ? replacer(key, val) : val;
  };
  return originalStringify(value, customReplacer, space);
};

export interface MigrationStats {
  totalUsers: number;
  migratedUsers: number;
  skippedUsers: number;
  errors: string[];
  details: {
    [key: string]: {
      before: {
        isEmailVerified: boolean;
        isRater: boolean;
        isSuperAdmin: boolean;
        isRatingBanned: boolean;
        status: string;
        isBanned: boolean;
        isSubmissionsPaused: boolean;
      };
      after: {
        permissionFlags: bigint;
        permissionNames: string[];
      };
    };
  };
}

export class PermissionMigrationService {
  private static instance: PermissionMigrationService;

  public static getInstance(): PermissionMigrationService {
    if (!PermissionMigrationService.instance) {
      PermissionMigrationService.instance = new PermissionMigrationService();
    }
    return PermissionMigrationService.instance;
  }

  /**
   * Convert boolean permissions to bit-based permission flags
   */
  private convertBooleanToPermissionFlags(user: User, player?: Player): bigint {
    let flags = 0n;

    // User-level permissions
    if (user.isEmailVerified) {
      flags |= permissionFlags.EMAIL_VERIFIED;
    }

    if (user.isRater) {
      flags |= permissionFlags.RATER;
    }

    if (user.isSuperAdmin) {
      flags |= permissionFlags.SUPER_ADMIN;
    }

    if (user.isRatingBanned) {
      flags |= permissionFlags.RATING_BANNED;
    }

    // Status-based permissions
    if (user.status === 'banned') {
      flags |= permissionFlags.BANNED;
    }

    // Player-level permissions (if player exists)
    if (player) {
      if (player.isBanned) {
        flags |= permissionFlags.BANNED;
      }

      if (player.isSubmissionsPaused) {
        flags |= permissionFlags.SUBMISSIONS_PAUSED;
      }
    }

    return flags;
  }

  /**
   * Get permission names for a given permission flags value
   */
  private getPermissionNames(flags: bigint): string[] {
    const names: string[] = [];
    
    Object.entries(permissionFlags).forEach(([name, flag]) => {
      if ((flags & flag) === flag) {
        names.push(name);
      }
    });
    
    return names;
  }

  /**
   * Migrate a single user's permissions
   */
  private async migrateUserPermissions(
    user: User, 
    player?: Player, 
    transaction?: Transaction
  ): Promise<{ success: boolean; error?: string; before?: any; after?: any }> {
    try {
      // Get current boolean permissions
      const before = {
        isEmailVerified: user.isEmailVerified,
        isRater: user.isRater,
        isSuperAdmin: user.isSuperAdmin,
        isRatingBanned: user.isRatingBanned,
        status: user.status,
        isBanned: player?.isBanned || false,
        isSubmissionsPaused: player?.isSubmissionsPaused || false,
      };

      // Convert to permission flags
      const newPermissionFlags = this.convertBooleanToPermissionFlags(user, player);
      const permissionNames = this.getPermissionNames(newPermissionFlags);

             // Update user with new permission flags
       await user.update({
         permissionFlags: newPermissionFlags,
         permissionVersion: (user.permissionVersion || 0) + 1
       }, { transaction });

      const after = {
        permissionFlags: newPermissionFlags,
        permissionNames
      };

      return { success: true, before, after };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Failed to migrate user ${user.id} (${user.username}):`, error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Migrate all users' permissions to the new bit-based system
   */
  public async migrateAllUsers(dryRun: boolean = false): Promise<MigrationStats> {
    const stats: MigrationStats = {
      totalUsers: 0,
      migratedUsers: 0,
      skippedUsers: 0,
      errors: [],
      details: {}
    };

    const transaction = await sequelize.transaction();

    try {
      logger.info('Starting permission migration...');
      if (dryRun) {
        logger.info('DRY RUN MODE - No changes will be made to the database');
      }

             // Get all users first
       const users = await User.findAll({
         transaction
       });

       // Get all players for the users
       const playerIds = users.map(user => user.playerId).filter(id => id !== undefined);
       const players = await Player.findAll({
         where: {
           id: playerIds
         },
         transaction
       });

       // Create a map of playerId to player for easy lookup
       const playerMap = new Map(players.map(player => [player.id, player]));

      stats.totalUsers = users.length;
      logger.info(`Found ${stats.totalUsers} users to migrate`);

      for (const user of users) {
        try {
                   // Skip if user already has permission flags set (unless it's 0)
         const userFlags = BigInt(user.permissionFlags || 0);
         if (userFlags !== 0n) {
                         logger.debug(`Skipping user ${user.username} - already has permission flags: ${userFlags}`);
            stats.skippedUsers++;
            continue;
          }

          // Get the associated player for this user
          const player = user.playerId ? playerMap.get(user.playerId) : undefined;
          const result = await this.migrateUserPermissions(user, player, dryRun ? undefined : transaction);
          
          if (result.success) {
            stats.migratedUsers++;
            stats.details[user.username] = {
              before: result.before!,
              after: result.after!
            };

            logger.info(`Migrated user ${user.username}: ${result.before?.isRater ? 'RATER' : ''} ${result.before?.isSuperAdmin ? 'SUPER_ADMIN' : ''} -> ${result.after?.permissionNames.join(', ')}`);
          } else {
            stats.errors.push(`User ${user.username}: ${result.error}`);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          stats.errors.push(`User ${user.username}: ${errorMessage}`);
          logger.error(`Error processing user ${user.username}:`, error);
        }
      }

      if (!dryRun) {
        await transaction.commit();
        logger.info('Permission migration completed successfully');
      } else {
        await transaction.rollback();
        logger.info('DRY RUN completed - no changes made');
      }

      // Log summary
      logger.info(`Migration Summary:
        - Total users: ${stats.totalUsers}
        - Migrated: ${stats.migratedUsers}
        - Skipped: ${stats.skippedUsers}
        - Errors: ${stats.errors.length}`);

      if (stats.errors.length > 0) {
        logger.warn('Migration errors:', stats.errors);
      }

    } catch (error) {
      await transaction.rollback();
      logger.error('Migration failed:', error);
      throw error;
    }

    return stats;
  }

  /**
   * Migrate a specific user's permissions
   */
  public async migrateUser(userId: string, dryRun: boolean = false): Promise<{ success: boolean; error?: string; before?: any; after?: any }> {
    const transaction = await sequelize.transaction();

    try {
      const user = await User.findByPk(userId, {
        transaction
      });

      if (!user) {
        await transaction.rollback();
        return { success: false, error: 'User not found' };
      }

      // Get the associated player
      const player = user.playerId ? await Player.findByPk(user.playerId, { transaction }) : undefined;

      const result = await this.migrateUserPermissions(user, player || undefined, dryRun ? undefined : transaction);

      if (!dryRun) {
        await transaction.commit();
      } else {
        await transaction.rollback();
      }

      return result;
    } catch (error) {
      await transaction.rollback();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Verify migration by checking if all users have proper permission flags
   */
  public async verifyMigration(): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];

    try {
      const users = await User.findAll();

      // Get all players for the users
      const playerIds = users.map(user => user.playerId).filter(id => id !== undefined);
      const players = await Player.findAll({
        where: {
          id: playerIds
        }
      });

      // Create a map of playerId to player for easy lookup
      const playerMap = new Map(players.map(player => [player.id, player]));

      for (const user of users) {
        const player = user.playerId ? playerMap.get(user.playerId) : undefined;
        const expectedFlags = this.convertBooleanToPermissionFlags(user, player);
        
                 const userFlags = BigInt(user.permissionFlags || 0);
         if (userFlags !== expectedFlags) {
           issues.push(`User ${user.username}: Expected flags ${expectedFlags}, got ${userFlags}`);
         }
      }

      return {
        valid: issues.length === 0,
        issues
      };
    } catch (error) {
      logger.error('Verification failed:', error);
      return {
        valid: false,
        issues: ['Verification process failed']
      };
    }
  }

  /**
   * Rollback migration by clearing permission flags
   */
  public async rollbackMigration(dryRun: boolean = false): Promise<{ success: boolean; error?: string; affectedUsers: number }> {
    const transaction = await sequelize.transaction();

    try {
      const users = await User.findAll({
        where: {
          permissionFlags: {
            [Op.ne]: 0n
          }
        },
        transaction
      });

      if (!dryRun) {
        await User.update(
          { 
            permissionFlags: 0n,
            permissionVersion: sequelize.literal('permissionVersion + 1')
          },
          {
            where: {
              permissionFlags: {
                [Op.ne]: 0n
              }
            },
            transaction
          }
        );
      }

      await transaction.commit();

      return {
        success: true,
        affectedUsers: users.length
      };
    } catch (error) {
      await transaction.rollback();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage, affectedUsers: 0 };
    }
  }
}

export default PermissionMigrationService;
