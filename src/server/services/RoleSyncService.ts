import { Op } from 'sequelize';
import DiscordRoleClient from '../../misc/webhook/classes/discordRoleClient.js';
import { DiscordGuild, DiscordSyncRole } from '../../models/discord/index.js';
import Difficulty from '../../models/levels/Difficulty.js';
import Level from '../../models/levels/Level.js';
import Player from '../../models/players/Player.js';
import User from '../../models/auth/User.js';
import OAuthProvider from '../../models/auth/OAuthProvider.js';
import Creator from '../../models/credits/Creator.js';
import LevelCredit from '../../models/levels/LevelCredit.js';
import Curation from '../../models/curations/Curation.js';
import CurationType from '../../models/curations/CurationType.js';
import { logger } from './LoggerService.js';
import { PlayerStatsService } from './PlayerStatsService.js';

export interface RoleSyncResult {
  success: boolean;
  guildId: string;
  guildName: string;
  rolesAdded: string[];
  rolesRemoved: string[];
  errors: string[];
}

export interface UserSyncResult {
  discordId: string | null;
  results: RoleSyncResult[];
  errors: string[];
}

/**
 * Service for synchronizing Discord roles based on player achievements
 * Supports difficulty-based roles (player clears) and curation-based roles (creator credits)
 */
class RoleSyncService {
  private static instance: RoleSyncService;
  private playerStatsService: PlayerStatsService;

  private constructor() {
    this.playerStatsService = PlayerStatsService.getInstance();
  }

  /**
   * Check if an error is non-critical (expected behavior, doesn't need ERROR level logging)
   */
  private isNonCriticalError(errorMsg: string, statusCode?: number): boolean {
    // 404 errors are typically non-critical (user not in guild, role not found, etc.)
    if (statusCode === 404) {
      return true;
    }
    
    // Check for specific non-critical error messages
    const nonCriticalPatterns = [
      /user not found in guild/i,
      /member not found/i,
      /role not found/i,
    ];
    
    return nonCriticalPatterns.some(pattern => pattern.test(errorMsg));
  }

  public static getInstance(): RoleSyncService {
    if (!RoleSyncService.instance) {
      RoleSyncService.instance = new RoleSyncService();
    }
    return RoleSyncService.instance;
  }

  /**
   * Get Discord ID for a user by their user ID
   */
  async getDiscordIdForUser(userId: string): Promise<string | null> {
    try {
      logger.debug(`[RoleSyncService] Getting Discord ID for user ${userId}`);
      const provider = await OAuthProvider.findOne({
        where: {
          userId,
          provider: 'discord',
        },
      });

      const discordId = provider?.providerId || null;
      logger.debug(`[RoleSyncService] Found Discord ID for user ${userId}: ${discordId || 'none'}`);
      return discordId;
    } catch (error: any) {
      logger.error(`RoleSyncService.getDiscordIdForUser error: ${error.message}`);
      return null;
    }
  }

  /**
   * Get Discord ID for a player by their player ID
   */
  async getDiscordIdForPlayer(playerId: number): Promise<string | null> {
    try {
      logger.debug(`[RoleSyncService] Getting Discord ID for player ${playerId}`);
      const user = await User.findOne({
        where: { playerId },
        include: [{
          model: OAuthProvider,
          as: 'providers',
          where: { provider: 'discord' },
          required: false,
        }],
      });

      if (!user || !user.providers || user.providers.length === 0) {
        logger.debug(`[RoleSyncService] Player ${playerId} has no linked Discord account`);
        return null;
      }

      const discordId = user.providers[0].providerId;
      logger.debug(`[RoleSyncService] Found Discord ID for player ${playerId}: ${discordId}`);
      return discordId;
    } catch (error: any) {
      logger.error(`RoleSyncService.getDiscordIdForPlayer error: ${error.message}`);
      return null;
    }
  }

  /**
   * Get the highest difficulty cleared by a player (based on sortOrder)
   * Uses PlayerStatsService to get the top difficulty from cached stats
   */
  async getHighestDifficultyClear(playerId: number): Promise<Difficulty | null> {
    try {
      logger.debug(`[RoleSyncService] Getting highest difficulty clear for player ${playerId}`);
      const stats = await this.playerStatsService.getPlayerStats(playerId);
      
      if (!stats || stats.length === 0) {
        logger.debug(`[RoleSyncService] No stats found for player ${playerId}`);
        return null;
      }

      const playerStats = stats[0];
      const difficulty = playerStats.topDiff as Difficulty | null;
      logger.debug(`[RoleSyncService] Highest difficulty for player ${playerId}: ${difficulty?.name || 'none'}`);
      return difficulty;
    } catch (error: any) {
      logger.error(`RoleSyncService.getHighestDifficultyClear error: ${error.message}`);
      logger.debug(`[RoleSyncService] Exception getting highest difficulty: ${error.stack}`);
      return null;
    }
  }

  /**
   * Get all curation types that a creator has participated in
   */
  async getCreatorCurationTypes(creatorId: number): Promise<CurationType[]> {
    try {
      // Find all levels the creator has credits for
      const credits = await LevelCredit.findAll({
        where: { creatorId },
        include: [{
          model: Level,
          as: 'level',
          where: {
            isHidden: { [Op.ne]: true },
            isDeleted: { [Op.ne]: true },
          },
          include: [{
            model: Curation,
            as: 'curation',
            required: true,
            include: [{
              model: CurationType,
              as: 'type',
            }],
          }],
        }],
      });

      // Extract unique curation types
      const curationTypeMap = new Map<number, CurationType>();
      for (const credit of credits) {
        const curation = (credit.level as any)?.curation;
        if (curation?.type) {
          curationTypeMap.set(curation.type.id, curation.type);
        }
      }

      return Array.from(curationTypeMap.values());
    } catch (error: any) {
      logger.error(`RoleSyncService.getCreatorCurationTypes error: ${error.message}`);
      return [];
    }
  }

  /**
   * Get the highest curation type by sort order for a creator
   */
  async getHighestCurationTypeForCreator(creatorId: number): Promise<CurationType | null> {
    const types = await this.getCreatorCurationTypes(creatorId);
    if (types.length === 0) return null;

    // Sort by sortOrder descending (higher = better)
    types.sort((a, b) => (b.sortOrder || 0) - (a.sortOrder || 0));
    return types[0];
  }

  /**
   * Sync difficulty roles for a player across all active guilds
   */
  async syncDifficultyRolesForPlayer(playerId: number): Promise<UserSyncResult> {
    logger.debug(`[RoleSyncService] Starting difficulty role sync for player ${playerId}`);
    const errors: string[] = [];
    const results: RoleSyncResult[] = [];

    // Get Discord ID
    const discordId = await this.getDiscordIdForPlayer(playerId);
    if (!discordId) {
      logger.debug(`[RoleSyncService] Player ${playerId} has no Discord account, aborting sync`);
      return {
        discordId: null,
        results: [],
        errors: ['Player does not have a linked Discord account'],
      };
    }

    // Get highest difficulty clear
    const highestDifficulty = await this.getHighestDifficultyClear(playerId);
    logger.debug(`[RoleSyncService] Player ${playerId} highest difficulty: ${highestDifficulty?.name || 'none'}`);
    
    // Get all active guilds
    const guilds = await DiscordGuild.findAll({
      where: { isActive: true },
      include: [{
        model: DiscordSyncRole,
        as: 'roles',
        where: {
          type: 'DIFFICULTY',
          isActive: true,
        },
        required: false,
        include: [{
          model: Difficulty,
          as: 'difficulty',
        }],
      }],
    });

    logger.debug(`[RoleSyncService] Found ${guilds.length} active guilds for difficulty role sync`);

    for (const guild of guilds) {
      logger.debug(`[RoleSyncService] Syncing difficulty roles for guild ${guild.name} (${guild.guildId})`);
      const result = await this.syncDifficultyRolesForGuild(
        guild,
        discordId,
        highestDifficulty
      );
      results.push(result);
      logger.debug(`[RoleSyncService] Guild ${guild.name} sync result: ${result.success ? 'success' : 'failed'} - Added: ${result.rolesAdded.length}, Removed: ${result.rolesRemoved.length}, Errors: ${result.errors.length}`);
    }

    logger.debug(`[RoleSyncService] Completed difficulty role sync for player ${playerId}`);
    return { discordId, results, errors };
  }

  /**
   * Sync difficulty roles for a specific guild
   */
  private async syncDifficultyRolesForGuild(
    guild: DiscordGuild,
    discordId: string,
    highestDifficulty: Difficulty | null
  ): Promise<RoleSyncResult> {
    logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: Starting sync for user ${discordId} in guild ${guild.name}`);
    const result: RoleSyncResult = {
      success: true,
      guildId: guild.guildId,
      guildName: guild.name,
      rolesAdded: [],
      rolesRemoved: [],
      errors: [],
    };

    try {
      const client = new DiscordRoleClient(guild.botToken);
      const roles = (guild as any).roles as DiscordSyncRole[] || [];

      logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: Found ${roles.length} difficulty roles in guild ${guild.name}`);

      if (roles.length === 0) {
        logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: No roles to sync for guild ${guild.name}`);
        return result;
      }

      // Group roles by conflict group
      const conflictGroups = new Map<string, DiscordSyncRole[]>();
      const ungroupedRoles: DiscordSyncRole[] = [];

      for (const role of roles) {
        if (role.conflictGroup) {
          const group = conflictGroups.get(role.conflictGroup) || [];
          group.push(role);
          conflictGroups.set(role.conflictGroup, group);
        } else {
          ungroupedRoles.push(role);
        }
      }

      // Determine which roles the user should have
      const targetRoleIds: string[] = [];

      // Process conflict groups - only assign the highest qualifying role
      logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: Processing ${conflictGroups.size} conflict groups`);
      for (const [groupName, groupRoles] of conflictGroups) {
        // Sort by difficulty sortOrder descending
        groupRoles.sort((a, b) => {
          const aOrder = a.difficulty?.sortOrder || 0;
          const bOrder = b.difficulty?.sortOrder || 0;
          return bOrder - aOrder;
        });

        // Find the highest role the user qualifies for
        for (const role of groupRoles) {
          if (this.qualifiesForDifficultyRole(role, highestDifficulty)) {
            logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: User qualifies for role ${role.label} (${role.roleId}) in conflict group ${groupName}`);
            targetRoleIds.push(role.roleId);
            break; // Only add the highest qualifying role in the group
          }
        }
      }

      // Process ungrouped roles - add all qualifying roles
      logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: Processing ${ungroupedRoles.length} ungrouped roles`);
      for (const role of ungroupedRoles) {
        if (this.qualifiesForDifficultyRole(role, highestDifficulty)) {
          logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: User qualifies for ungrouped role ${role.label} (${role.roleId})`);
          targetRoleIds.push(role.roleId);
        }
      }

      // Get all managed role IDs (roles we're responsible for)
      const managedRoleIds = roles.map(r => r.roleId);
      logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: Target roles: ${targetRoleIds.length}, Managed roles: ${managedRoleIds.length}`);

      // Sync roles
      logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: Calling Discord API to sync roles`);
      const syncResult = await client.syncRoles(
        guild.guildId,
        discordId,
        targetRoleIds,
        managedRoleIds,
        'TUForums role sync'
      );
      logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: Sync completed - Added: ${syncResult.added.length}, Removed: ${syncResult.removed.length}`);

      // Track results
      logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: Processing sync results`);
      const criticalErrors: string[] = [];
      
      for (let i = 0; i < syncResult.added.length; i++) {
        const roleId = targetRoleIds[i];
        const role = roles.find(r => r.roleId === roleId);
        const roleLabel = role?.label || roleId || 'unknown';
        
        if (syncResult.added[i].success) {
          result.rolesAdded.push(roleId || 'unknown');
          logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: Successfully added role ${roleLabel} (${roleId})`);
        } else {
          const errorMsg = syncResult.added[i].error || 'Unknown error adding role';
          const statusCode = syncResult.added[i].statusCode;
          const isNonCritical = this.isNonCriticalError(errorMsg, statusCode);
          
          if (isNonCritical) {
            logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: User not in guild or role not found - Role: ${roleLabel} (${roleId}), Guild: ${guild.name} (${guild.guildId}), User: ${discordId}`);
          } else {
            result.errors.push(errorMsg);
            criticalErrors.push(errorMsg);
            logger.error(`[RoleSyncService] syncDifficultyRolesForGuild: Failed to add role ${roleLabel} (${roleId}) - Error: ${errorMsg}${statusCode ? ` (Status: ${statusCode})` : ''}`);
            logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: Role add failure details - Guild: ${guild.name} (${guild.guildId}), User: ${discordId}, Role: ${roleLabel} (${roleId}), Error: ${errorMsg}`);
          }
        }
      }

      for (let i = 0; i < syncResult.removed.length; i++) {
        const removed = syncResult.removed[i];
        if (removed.success) {
          logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: Successfully removed role`);
        } else {
          const errorMsg = removed.error || 'Unknown error removing role';
          const statusCode = removed.statusCode;
          const isNonCritical = this.isNonCriticalError(errorMsg, statusCode);
          
          if (isNonCritical) {
            logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: User not in guild - Role removal skipped, Guild: ${guild.name} (${guild.guildId}), User: ${discordId}`);
          } else {
            result.errors.push(errorMsg);
            criticalErrors.push(errorMsg);
            logger.error(`[RoleSyncService] syncDifficultyRolesForGuild: Failed to remove role - Error: ${errorMsg}${statusCode ? ` (Status: ${statusCode})` : ''}`);
            logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: Role remove failure details - Guild: ${guild.name} (${guild.guildId}), User: ${discordId}, Error: ${errorMsg}`);
          }
        }
      }

      if (criticalErrors.length > 0) {
        result.success = false;
        logger.error(`[RoleSyncService] syncDifficultyRolesForGuild: Sync completed with ${criticalErrors.length} critical error(s) for guild ${guild.name} (${guild.guildId})`);
        logger.error(`[RoleSyncService] syncDifficultyRolesForGuild: Critical errors: ${criticalErrors.join('; ')}`);
        logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: Full error details - Guild: ${guild.name}, User: ${discordId}, Errors: ${JSON.stringify(result.errors)}`);
      } else {
        logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: Sync completed successfully (non-critical errors ignored)`);
      }
    } catch (error: any) {
      result.success = false;
      result.errors.push(error.message);
      logger.error(`RoleSyncService.syncDifficultyRolesForGuild error: ${error.message}`);
      logger.debug(`[RoleSyncService] syncDifficultyRolesForGuild: Exception during sync: ${error.stack}`);
    }

    return result;
  }

  /**
   * Check if a user qualifies for a difficulty role
   */
  private qualifiesForDifficultyRole(
    role: DiscordSyncRole,
    highestDifficulty: Difficulty | null
  ): boolean {
    if (!highestDifficulty || !role.difficulty) {
      return false;
    }

    // User qualifies if their highest clear's sortOrder >= role's min difficulty sortOrder
    return highestDifficulty.sortOrder >= role.difficulty.sortOrder;
  }

  /**
   * Sync curation roles for a creator across all active guilds
   */
  async syncCurationRolesForCreator(creatorId: number): Promise<UserSyncResult> {
    logger.debug(`[RoleSyncService] Starting curation role sync for creator ${creatorId}`);
    const errors: string[] = [];
    const results: RoleSyncResult[] = [];

    // Get the creator and their user
    const creator = await Creator.findByPk(creatorId);
    if (!creator || !creator.userId) {
      logger.debug(`[RoleSyncService] Creator ${creatorId} not found or not linked to a user`);
      return {
        discordId: null,
        results: [],
        errors: ['Creator not found or not linked to a user'],
      };
    }

    // Get Discord ID
    const discordId = await this.getDiscordIdForUser(creator.userId);
    if (!discordId) {
      logger.debug(`[RoleSyncService] Creator ${creatorId} has no Discord account, aborting sync`);
      return {
        discordId: null,
        results: [],
        errors: ['Creator does not have a linked Discord account'],
      };
    }

    // Get highest curation type
    const highestCurationType = await this.getHighestCurationTypeForCreator(creatorId);
    logger.debug(`[RoleSyncService] Creator ${creatorId} highest curation type: ${highestCurationType?.name || 'none'}`);

    // Get all curation types the creator has
    const allCurationTypes = await this.getCreatorCurationTypes(creatorId);
    const curationTypeIds = allCurationTypes.map(ct => ct.id);
    logger.debug(`[RoleSyncService] Creator ${creatorId} has ${curationTypeIds.length} curation types`);

    // Get all active guilds
    const guilds = await DiscordGuild.findAll({
      where: { isActive: true },
      include: [{
        model: DiscordSyncRole,
        as: 'roles',
        where: {
          type: 'CURATION',
          isActive: true,
        },
        required: false,
        include: [{
          model: CurationType,
          as: 'curationType',
        }],
      }],
    });

    logger.debug(`[RoleSyncService] Found ${guilds.length} active guilds for curation role sync`);

    for (const guild of guilds) {
      logger.debug(`[RoleSyncService] Syncing curation roles for guild ${guild.name} (${guild.guildId})`);
      const result = await this.syncCurationRolesForGuild(
        guild,
        discordId,
        curationTypeIds,
        highestCurationType
      );
      results.push(result);
      logger.debug(`[RoleSyncService] Guild ${guild.name} sync result: ${result.success ? 'success' : 'failed'} - Added: ${result.rolesAdded.length}, Removed: ${result.rolesRemoved.length}, Errors: ${result.errors.length}`);
    }

    logger.debug(`[RoleSyncService] Completed curation role sync for creator ${creatorId}`);
    return { discordId, results, errors };
  }

  /**
   * Sync curation roles for a specific guild
   */
  private async syncCurationRolesForGuild(
    guild: DiscordGuild,
    discordId: string,
    userCurationTypeIds: number[],
    highestCurationType: CurationType | null
  ): Promise<RoleSyncResult> {
    logger.debug(`[RoleSyncService] syncCurationRolesForGuild: Starting sync for user ${discordId} in guild ${guild.name}`);
    const result: RoleSyncResult = {
      success: true,
      guildId: guild.guildId,
      guildName: guild.name,
      rolesAdded: [],
      rolesRemoved: [],
      errors: [],
    };

    try {
      const client = new DiscordRoleClient(guild.botToken);
      const roles = (guild as any).roles as DiscordSyncRole[] || [];

      logger.debug(`[RoleSyncService] syncCurationRolesForGuild: Found ${roles.length} curation roles in guild ${guild.name}`);

      if (roles.length === 0) {
        logger.debug(`[RoleSyncService] syncCurationRolesForGuild: No roles to sync for guild ${guild.name}`);
        return result;
      }

      // Group roles by conflict group
      const conflictGroups = new Map<string, DiscordSyncRole[]>();
      const ungroupedRoles: DiscordSyncRole[] = [];

      for (const role of roles) {
        if (role.conflictGroup) {
          const group = conflictGroups.get(role.conflictGroup) || [];
          group.push(role);
          conflictGroups.set(role.conflictGroup, group);
        } else {
          ungroupedRoles.push(role);
        }
      }

      // Determine which roles the user should have
      const targetRoleIds: string[] = [];

      // Process conflict groups - only assign the highest qualifying role
      for (const [groupName, groupRoles] of conflictGroups) {
        // Sort by curation type sortOrder descending
        groupRoles.sort((a, b) => {
          const aOrder = a.curationType?.sortOrder || 0;
          const bOrder = b.curationType?.sortOrder || 0;
          return bOrder - aOrder;
        });

        // Find the highest role the user qualifies for
        for (const role of groupRoles) {
          if (role.curationTypeId && userCurationTypeIds.includes(role.curationTypeId)) {
            targetRoleIds.push(role.roleId);
            break; // Only add the highest qualifying role in the group
          }
        }
      }

      // Process ungrouped roles - add all qualifying roles
      for (const role of ungroupedRoles) {
        if (role.curationTypeId && userCurationTypeIds.includes(role.curationTypeId)) {
          targetRoleIds.push(role.roleId);
        }
      }

      // Get all managed role IDs
      const managedRoleIds = roles.map(r => r.roleId);
      logger.debug(`[RoleSyncService] syncCurationRolesForGuild: Target roles: ${targetRoleIds.length}, Managed roles: ${managedRoleIds.length}`);

      // Sync roles
      logger.debug(`[RoleSyncService] syncCurationRolesForGuild: Calling Discord API to sync roles`);
      const syncResult = await client.syncRoles(
        guild.guildId,
        discordId,
        targetRoleIds,
        managedRoleIds,
        'TUForums curation role sync'
      );
      logger.debug(`[RoleSyncService] syncCurationRolesForGuild: Sync completed - Added: ${syncResult.added.length}, Removed: ${syncResult.removed.length}`);

      // Track detailed errors (only critical ones)
      const criticalErrors: string[] = [];
      
      syncResult.added.forEach((r, i) => {
        if (!r.success) {
          const roleId = targetRoleIds[i];
          const role = roles.find(role => role.roleId === roleId);
          const roleLabel = role?.label || roleId || 'unknown';
          const errorMsg = r.error || 'Unknown error';
          const statusCode = r.statusCode;
          const isNonCritical = this.isNonCriticalError(errorMsg, statusCode);
          
          if (isNonCritical) {
            logger.debug(`[RoleSyncService] syncCurationRolesForGuild: User not in guild or role not found - Role: ${roleLabel} (${roleId}), Guild: ${guild.name} (${guild.guildId}), User: ${discordId}`);
          } else {
            result.errors.push(errorMsg);
            criticalErrors.push(errorMsg);
            logger.error(`[RoleSyncService] syncCurationRolesForGuild: Failed to add role ${roleLabel} (${roleId}) - Error: ${errorMsg}${statusCode ? ` (Status: ${statusCode})` : ''}`);
            logger.debug(`[RoleSyncService] syncCurationRolesForGuild: Role add failure details - Guild: ${guild.name} (${guild.guildId}), User: ${discordId}, Role: ${roleLabel} (${roleId}), Error: ${errorMsg}`);
          }
        }
      });

      syncResult.removed.forEach((r) => {
        if (!r.success) {
          const errorMsg = r.error || 'Unknown error';
          const statusCode = r.statusCode;
          const isNonCritical = this.isNonCriticalError(errorMsg, statusCode);
          
          if (isNonCritical) {
            logger.debug(`[RoleSyncService] syncCurationRolesForGuild: User not in guild - Role removal skipped, Guild: ${guild.name} (${guild.guildId}), User: ${discordId}`);
          } else {
            result.errors.push(errorMsg);
            criticalErrors.push(errorMsg);
            logger.error(`[RoleSyncService] syncCurationRolesForGuild: Failed to remove role - Error: ${errorMsg}${statusCode ? ` (Status: ${statusCode})` : ''}`);
            logger.debug(`[RoleSyncService] syncCurationRolesForGuild: Role remove failure details - Guild: ${guild.name} (${guild.guildId}), User: ${discordId}, Error: ${errorMsg}`);
          }
        }
      });

      if (criticalErrors.length > 0) {
        result.success = false;
        logger.error(`[RoleSyncService] syncCurationRolesForGuild: Sync completed with ${criticalErrors.length} critical error(s) for guild ${guild.name} (${guild.guildId})`);
        logger.error(`[RoleSyncService] syncCurationRolesForGuild: Critical errors: ${criticalErrors.join('; ')}`);
        logger.debug(`[RoleSyncService] syncCurationRolesForGuild: Full error details - Guild: ${guild.name}, User: ${discordId}, Errors: ${JSON.stringify(result.errors)}`);
      } else {
        logger.debug(`[RoleSyncService] syncCurationRolesForGuild: Sync completed successfully (non-critical errors ignored)`);
      }
    } catch (error: any) {
      result.success = false;
      result.errors.push(error.message);
      logger.error(`RoleSyncService.syncCurationRolesForGuild error: ${error.message}`);
      logger.debug(`[RoleSyncService] syncCurationRolesForGuild: Exception during sync: ${error.stack}`);
    }

    return result;
  }

  /**
   * Sync all roles (difficulty + curation) for a user
   */
  async syncAllRolesForUser(userId: string): Promise<{
    difficulty: UserSyncResult | null;
    curation: UserSyncResult | null;
  }> {
    logger.debug(`[RoleSyncService] syncAllRolesForUser: Starting sync for user ${userId}`);
    let difficultyResult: UserSyncResult | null = null;
    let curationResult: UserSyncResult | null = null;

    // Get user with player and creator associations
    const user = await User.findByPk(userId, {
      include: [
        { model: Player, as: 'player' },
      ],
    });

    if (!user) {
      logger.debug(`[RoleSyncService] syncAllRolesForUser: User ${userId} not found`);
      return { difficulty: null, curation: null };
    }

    logger.debug(`[RoleSyncService] syncAllRolesForUser: User ${userId} - playerId: ${user.playerId || 'none'}, creatorId: ${user.creatorId || 'none'}`);

    // Sync difficulty roles if user has a player
    if (user.playerId) {
      logger.debug(`[RoleSyncService] syncAllRolesForUser: Syncing difficulty roles for player ${user.playerId}`);
      difficultyResult = await this.syncDifficultyRolesForPlayer(user.playerId);
    } else {
      logger.debug(`[RoleSyncService] syncAllRolesForUser: User ${userId} has no player, skipping difficulty sync`);
    }

    // Sync curation roles if user has a creator
    if (user.creatorId) {
      logger.debug(`[RoleSyncService] syncAllRolesForUser: Syncing curation roles for creator ${user.creatorId}`);
      curationResult = await this.syncCurationRolesForCreator(user.creatorId);
    } else {
      logger.debug(`[RoleSyncService] syncAllRolesForUser: User ${userId} has no creator, skipping curation sync`);
    }

    logger.debug(`[RoleSyncService] syncAllRolesForUser: Completed sync for user ${userId}`);
    return { difficulty: difficultyResult, curation: curationResult };
  }

  /**
   * Manual sync trigger for admin use
   */
  async manualSync(userId: string): Promise<{
    difficulty: UserSyncResult | null;
    curation: UserSyncResult | null;
  }> {
    logger.debug(`Manual role sync triggered for user ${userId}`);
    return this.syncAllRolesForUser(userId);
  }

  /**
   * Test if a bot can manage roles in a guild
   * Tests by attempting to get the bot's own member info and checking permissions
   */
  async testBotPermissions(botToken: string, guildId: string, testRoleId?: string): Promise<{
    success: boolean;
    error?: string;
    canManageRoles: boolean;
  }> {
    try {
      logger.debug(`[RoleSyncService] Testing bot permissions for guild ${guildId}`);

      // First, try to get the bot's own member info to verify it's in the guild
      // We'll use a test user ID (the bot itself) - but we need to get the bot's user ID first
      // For simplicity, we'll try to get guild info which requires basic permissions
      const DISCORD_API_BASE = 'https://discord.com/api/v10';

      // Get bot's own user info
      const botUserResponse = await fetch(`${DISCORD_API_BASE}/users/@me`, {
        headers: {
          'Authorization': `Bot ${botToken}`,
        },
      });

      if (botUserResponse.status !== 200) {
        const error = `Failed to get bot user info: ${botUserResponse.status}`;
        logger.debug(`[RoleSyncService] Bot permission test failed: ${error}`);
        return {
          success: false,
          error: 'Invalid bot token',
          canManageRoles: false,
        };
      }

      const botUser = await botUserResponse.json() as { id: string };
      logger.debug(`[RoleSyncService] Bot user ID: ${botUser.id}`);

      // Try to get bot's member info in the guild
      const memberResponse = await fetch(`${DISCORD_API_BASE}/guilds/${guildId}/members/${botUser.id}`, {
        headers: {
          'Authorization': `Bot ${botToken}`,
        },
      });

      if (memberResponse.status === 404) {
        const error = 'Bot is not a member of this guild';
        logger.debug(`[RoleSyncService] Bot permission test failed: ${error}`);
        return {
          success: false,
          error,
          canManageRoles: false,
        };
      }

      if (memberResponse.status !== 200) {
        const error = `Failed to get bot member info: ${memberResponse.status}`;
        logger.debug(`[RoleSyncService] Bot permission test failed: ${error}`);
        return {
          success: false,
          error,
          canManageRoles: false,
        };
      }
      
      // Get guild info to check bot's permissions
      const guildResponse = await fetch(`${DISCORD_API_BASE}/guilds/${guildId}`, {
        headers: {
          'Authorization': `Bot ${botToken}`,
        },
      });

      if (guildResponse.status !== 200) {
        const error = `Failed to get guild info: ${guildResponse.status}`;
        logger.debug(`[RoleSyncService] Bot permission test failed: ${error}`);
        return {
          success: false,
          error,
          canManageRoles: false,
        };
      }

      // If a specific role ID is provided, test if we can manage that role
      if (testRoleId) {
        logger.debug(`[RoleSyncService] Testing permission to manage specific role ${testRoleId}`);
        // Try to get role info - if we can't, the bot likely can't manage it
        const roleResponse = await fetch(`${DISCORD_API_BASE}/guilds/${guildId}/roles/${testRoleId}`, {
          headers: {
            'Authorization': `Bot ${botToken}`,
          },
        });

        if (roleResponse.status === 404) {
          const error = `Role ${testRoleId} not found in guild`;
          logger.debug(`[RoleSyncService] Bot permission test failed: ${error}`);
          return {
            success: false,
            error,
            canManageRoles: false,
          };
        }

        if (roleResponse.status === 403) {
          const error = `Bot lacks permission to access role ${testRoleId}`;
          logger.debug(`[RoleSyncService] Bot permission test failed: ${error}`);
          return {
            success: false,
            error,
            canManageRoles: false,
          };
        }

        if (roleResponse.status === 200) {
          const role = await roleResponse.json() as { position: number };
          // Check if bot's highest role is above the target role
          // For now, we'll assume if we can read the role, we might be able to manage it
          // The actual permission check happens when trying to assign it
          logger.debug(`[RoleSyncService] Bot can access role ${testRoleId} (position: ${role.position})`);
        }
      }

      logger.debug(`[RoleSyncService] Bot permission test passed for guild ${guildId}`);
      return {
        success: true,
        canManageRoles: true,
      };
    } catch (error: any) {
      logger.debug(`[RoleSyncService] Bot permission test exception: ${error.message}`);
      return {
        success: false,
        error: error.message,
        canManageRoles: false,
      };
    }
  }

  /**
   * Test if a bot can manage a specific role by attempting to assign it to the bot itself
   * This is a more accurate test than just checking role info
   */
  async testRoleAssignmentPermission(
    botToken: string,
    guildId: string,
    roleId: string
  ): Promise<{
    success: boolean;
    error?: string;
    canManageRole: boolean;
  }> {
    try {
      logger.debug(`[RoleSyncService] Testing role assignment permission for role ${roleId} in guild ${guildId}`);
      const client = new DiscordRoleClient(botToken);

      // Get bot's own user ID
      const DISCORD_API_BASE = 'https://discord.com/api/v10';

      const botUserResponse = await fetch(`${DISCORD_API_BASE}/users/@me`, {
        headers: {
          'Authorization': `Bot ${botToken}`,
        },
      });

      if (botUserResponse.status !== 200) {
        const error = `Failed to get bot user info: ${botUserResponse.status}`;
        logger.debug(`[RoleSyncService] Role assignment test failed: ${error}`);
        return {
          success: false,
          error: 'Invalid bot token',
          canManageRole: false,
        };
      }

      const botUser = await botUserResponse.json() as { id: string };
      logger.debug(`[RoleSyncService] Bot user ID: ${botUser.id}`);

      // Check if bot already has this role
      const hasRole = await client.hasRole(guildId, botUser.id, roleId);
      
      if (hasRole) {
        // Bot already has the role, try removing and re-adding it
        logger.debug(`[RoleSyncService] Bot already has role ${roleId}, testing remove/add cycle`);
        const removeResult = await client.removeRole(guildId, botUser.id, roleId, 'Permission test');
        
        if (!removeResult.success) {
          const error = removeResult.error || 'Failed to remove role';
          logger.debug(`[RoleSyncService] Role assignment test failed: Cannot remove role - ${error}`);
          return {
            success: false,
            error: `Cannot manage role: ${error}`,
            canManageRole: false,
          };
        }

        // Try to add it back
        const addResult = await client.addRole(guildId, botUser.id, roleId, 'Permission test');
        
        if (!addResult.success) {
          const error = addResult.error || 'Failed to add role';
          logger.debug(`[RoleSyncService] Role assignment test failed: Cannot add role - ${error}`);
          return {
            success: false,
            error: `Cannot manage role: ${error}`,
            canManageRole: false,
          };
        }

        logger.debug(`[RoleSyncService] Role assignment test passed: Bot can manage role ${roleId}`);
        return {
          success: true,
          canManageRole: true,
        };
      } else {
        // Bot doesn't have the role, try adding it
        logger.debug(`[RoleSyncService] Bot does not have role ${roleId}, testing add operation`);
        const addResult = await client.addRole(guildId, botUser.id, roleId, 'Permission test');
        
        if (!addResult.success) {
          const error = addResult.error || 'Failed to add role';
          logger.debug(`[RoleSyncService] Role assignment test failed: Cannot add role - ${error}`);
          return {
            success: false,
            error: `Cannot manage role: ${error}`,
            canManageRole: false,
          };
        }

        // Remove it immediately to clean up
        await client.removeRole(guildId, botUser.id, roleId, 'Permission test cleanup');
        
        logger.debug(`[RoleSyncService] Role assignment test passed: Bot can manage role ${roleId}`);
        return {
          success: true,
          canManageRole: true,
        };
      }
    } catch (error: any) {
      logger.debug(`[RoleSyncService] Role assignment test exception: ${error.message}`);
      return {
        success: false,
        error: error.message,
        canManageRole: false,
      };
    }
  }
}

export default RoleSyncService;
export const roleSyncService = RoleSyncService.getInstance();
