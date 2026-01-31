import { addDiscordRole, removeDiscordRole, getDiscordMember } from '../api/sendRoleRequest.js';
import { logger } from '../../../server/services/LoggerService.js';

export interface DiscordMember {
  user: {
    id: string;
    username: string;
    discriminator: string;
    avatar: string | null;
  };
  roles: string[];
  nick?: string;
  joined_at: string;
}

export interface RoleOperationResult {
  success: boolean;
  error?: string;
  statusCode?: number;
}

/**
 * Discord Role Client for managing user roles via Discord REST API
 * Handles rate limiting, retries, and error handling
 */
export default class DiscordRoleClient {
  private botToken: string;
  private throwErrors: boolean;

  constructor(botToken: string, options?: { throwErrors?: boolean }) {
    this.botToken = botToken;
    this.throwErrors = options?.throwErrors ?? false;
  }

  /**
   * Add a role to a user in a guild
   */
  async addRole(
    guildId: string,
    userId: string,
    roleId: string,
    reason?: string
  ): Promise<RoleOperationResult> {
    try {
      const response = await addDiscordRole({
        botToken: this.botToken,
        guildId,
        userId,
        roleId,
        reason,
      });

      // 204 = success, 304 = already has role (also success)
      if (response.status === 204 || response.status === 304) {
        return { success: true };
      }

      // 404 = user not in guild
      if (response.status === 404) {
        const error = 'User not found in guild';
        if (this.throwErrors) throw new Error(error);
        return { success: false, error, statusCode: 404 };
      }

      // 403 = bot lacks permissions
      if (response.status === 403) {
        const error = 'Bot lacks permission to assign this role';
        if (this.throwErrors) throw new Error(error);
        return { success: false, error, statusCode: 403 };
      }

      const errorText = await response.text();
      const error = `Failed to add role: ${response.status} - ${errorText}`;
      logger.error(`DiscordRoleClient.addRole error: ${error}`);
      if (this.throwErrors) throw new Error(error);
      return { success: false, error, statusCode: response.status };
    } catch (err: any) {
      const error = `Exception adding role: ${err.message}`;
      logger.error(`DiscordRoleClient.addRole exception: ${error}`);
      if (this.throwErrors) throw err;
      return { success: false, error };
    }
  }

  /**
   * Remove a role from a user in a guild
   */
  async removeRole(
    guildId: string,
    userId: string,
    roleId: string,
    reason?: string
  ): Promise<RoleOperationResult> {
    try {
      const response = await removeDiscordRole({
        botToken: this.botToken,
        guildId,
        userId,
        roleId,
        reason,
      });

      // 204 = success, 304 = doesn't have role (also success)
      if (response.status === 204 || response.status === 304) {
        return { success: true };
      }

      // 404 = user not in guild
      if (response.status === 404) {
        const error = 'User not found in guild';
        if (this.throwErrors) throw new Error(error);
        return { success: false, error, statusCode: 404 };
      }

      // 403 = bot lacks permissions
      if (response.status === 403) {
        const error = 'Bot lacks permission to remove this role';
        if (this.throwErrors) throw new Error(error);
        return { success: false, error, statusCode: 403 };
      }

      const errorText = await response.text();
      const error = `Failed to remove role: ${response.status} - ${errorText}`;
      logger.error(`DiscordRoleClient.removeRole error: ${error}`);
      if (this.throwErrors) throw new Error(error);
      return { success: false, error, statusCode: response.status };
    } catch (err: any) {
      const error = `Exception removing role: ${err.message}`;
      logger.error(`DiscordRoleClient.removeRole exception: ${error}`);
      if (this.throwErrors) throw err;
      return { success: false, error };
    }
  }

  /**
   * Get current roles for a user in a guild
   */
  async getMemberRoles(guildId: string, userId: string): Promise<string[]> {
    try {
      const response = await getDiscordMember(this.botToken, guildId, userId);

      if (response.status === 200) {
        const member: DiscordMember = await response.json() as DiscordMember;
        return member.roles || [];
      }

      // 404 = user not in guild
      if (response.status === 404) {
        logger.debug(`User ${userId} not found in guild ${guildId}`);
        return [];
      }

      const errorText = await response.text();
      logger.error(`Failed to get member roles: ${response.status} - ${errorText}`);
      if (this.throwErrors) {
        throw new Error(`Failed to get member roles: ${response.status}`);
      }
      return [];
    } catch (err: any) {
      logger.error(`Exception getting member roles: ${err.message}`);
      if (this.throwErrors) throw err;
      return [];
    }
  }

  /**
   * Check if a user has a specific role
   */
  async hasRole(guildId: string, userId: string, roleId: string): Promise<boolean> {
    const roles = await this.getMemberRoles(guildId, userId);
    return roles.includes(roleId);
  }

  /**
   * Bulk add roles to a user
   */
  async addRoles(
    guildId: string,
    userId: string,
    roleIds: string[],
    reason?: string
  ): Promise<RoleOperationResult[]> {
    const results: RoleOperationResult[] = [];
    for (const roleId of roleIds) {
      const result = await this.addRole(guildId, userId, roleId, reason);
      results.push(result);
    }
    return results;
  }

  /**
   * Bulk remove roles from a user
   */
  async removeRoles(
    guildId: string,
    userId: string,
    roleIds: string[],
    reason?: string
  ): Promise<RoleOperationResult[]> {
    const results: RoleOperationResult[] = [];
    for (const roleId of roleIds) {
      const result = await this.removeRole(guildId, userId, roleId, reason);
      results.push(result);
    }
    return results;
  }

  /**
   * Sync roles: add new roles and remove old ones in a single operation
   */
  async syncRoles(
    guildId: string,
    userId: string,
    targetRoleIds: string[],
    managedRoleIds: string[],
    reason?: string
  ): Promise<{ added: RoleOperationResult[]; removed: RoleOperationResult[] }> {
    // Get current roles
    const currentRoles = await this.getMemberRoles(guildId, userId);
    
    // Filter to only managed roles that user currently has
    const currentManagedRoles = currentRoles.filter(r => managedRoleIds.includes(r));
    
    // Determine roles to add (in target but not in current)
    const rolesToAdd = targetRoleIds.filter(r => !currentManagedRoles.includes(r));
    
    // Determine roles to remove (in current managed but not in target)
    const rolesToRemove = currentManagedRoles.filter(r => !targetRoleIds.includes(r));

    // Execute operations
    const added = await this.addRoles(guildId, userId, rolesToAdd, reason);
    const removed = await this.removeRoles(guildId, userId, rolesToRemove, reason);

    return { added, removed };
  }
}
