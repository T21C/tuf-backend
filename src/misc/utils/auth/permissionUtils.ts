import { Op } from 'sequelize';
import sequelize from '../../../config/db.js';
import { User } from '../../../models/index.js';
import { UserAttributes } from '../../../models/auth/User.js';
import { Transaction } from 'sequelize';
import { permissionFlags } from '../../../config/constants.js';
import { Literal } from 'sequelize/lib/utils';


export type PermissionInput = bigint | number | User | UserAttributes | null | undefined;

/**
 * Extract permission flags from various input types
 */
const extractPermissionFlags = (input: PermissionInput): bigint => {
  if (typeof input === 'object' && input !== null && input !== undefined) {
    // If it's a user object, use permissionFlags or fallback to boolean flags
    if ('permissionFlags' in input && input.permissionFlags !== undefined) {
      return BigInt(input.permissionFlags || 0);
    }

    // Fallback to boolean flags for backward compatibility
    let flags = 0n;
    if (input.isSuperAdmin) flags |= permissionFlags.SUPER_ADMIN;
    if (input.isRater) flags |= permissionFlags.RATER;
    if (input.isRatingBanned) flags |= permissionFlags.RATING_BANNED;
    if (input.isEmailVerified) flags |= permissionFlags.EMAIL_VERIFIED;
    if (input.status === 'banned') flags |= permissionFlags.BANNED;

    return flags;
  }

  // If it's a number or bigint, convert to bigint
  return BigInt(input || 0);
};

/**
 * Check if a user has a specific permission flag
 * @param user - User object or permission flags
 * @param permission - Permission flag to check
 */
export const hasFlag = (user: PermissionInput, permission: bigint): boolean => {
  const flags = extractPermissionFlags(user);
  return (flags & permission) === permission;
};

/**
 * Check if a user has any of the specified permissions
 * @param user - User object or permission flags
 * @param permissions - Array of permission flags to check
 */
export const hasAnyFlag = (user: PermissionInput, permissions: bigint[]): boolean => {
  const flags = extractPermissionFlags(user);
  return permissions.some(permission => (flags & permission) === permission);
};

/**
 * Check if a user has all of the specified permissions
 * @param user - User object or permission flags
 * @param permissions - Array of permission flags to check
 */
export const hasAllPermissions = (user: PermissionInput, permissions: bigint[]): boolean => {
  const flags = extractPermissionFlags(user);
  return permissions.every(permission => (flags & permission) === permission);
};

/**
 * Add a permission to a user's permission flags
 * @param user - User object or permission flags
 * @param permission - Permission flag to add
 */
export const addPermission = (user: PermissionInput, permission: bigint): bigint => {
  const flags = extractPermissionFlags(user);
  return flags | permission;
};

/**
 * Remove a permission from a user's permission flags
 * @param user - User object or permission flags
 * @param permission - Permission flag to remove
 */
export const removePermission = (user: PermissionInput, permission: bigint): bigint => {
  const flags = extractPermissionFlags(user);
  return flags & ~permission;
};

/**
 * Create a Sequelize where clause for checking if a user has a specific permission
 */
export const wherehasFlag = (permission: bigint): Literal => {
  return sequelize.literal(`(permissionFlags & ${permission}) = ${permission}`);
};

/**
 * Create a Sequelize where clause for checking if a user has any of the specified permissions
 */
export const wherehasAnyFlag = (permissions: bigint[]): any => {
  const conditions = permissions.map(permission =>
    sequelize.literal(`(permissionFlags & ${permission}) = ${permission}`)
  );
  return {
    [Op.or]: conditions
  };
};

/**
 * Create a Sequelize where clause for checking if a user has all of the specified permissions
 */
export const whereHasAllPermissions = (permissions: bigint[]): any => {
  const conditions = permissions.map(permission =>
    sequelize.literal(`(permissionFlags & ${permission}) = ${permission}`)
  );
  return {
    [Op.and]: conditions
  };
};

/**
 * Generalized search utility functions to eliminate explicit flag dependencies
 */

/**
 * Create a where clause for users with a specific permission
 * @param permission - The permission flag to check for
 * @param hasPermission - Whether to check for having (true) or not having (false) the permission
 * @returns Sequelize literal for the where clause
 */
export const wherePermission = (permission: bigint, hasPermission = true): Literal => {
  const operator = hasPermission ? '=' : '!=';
  return sequelize.literal(`(permissionFlags & ${permission}) ${operator} ${permission}`);
};

/**
 * Create a where clause for users with any of the specified permissions
 * @param permissions - Array of permission flags to check for
 * @param hasPermission - Whether to check for having (true) or not having (false) the permissions
 * @returns Sequelize literal for the where clause
 */
export const whereAnyPermission = (permissions: bigint[], hasPermission = true): Literal => {
  const operator = hasPermission ? '=' : '!=';
  const conditions = permissions.map(permission =>
    `(permissionFlags & ${permission}) ${operator} ${permission}`
  ).join(' OR ');
  return sequelize.literal(`(${conditions})`);
};

/**
 * Create a where clause for users with all of the specified permissions
 * @param permissions - Array of permission flags to check for
 * @param hasPermission - Whether to check for having (true) or not having (false) the permissions
 * @returns Sequelize literal for the where clause
 */
export const whereAllPermissions = (permissions: bigint[], hasPermission = true): Literal => {
  const operator = hasPermission ? '=' : '!=';
  const conditions = permissions.map(permission =>
    `(permissionFlags & ${permission}) ${operator} ${permission}`
  ).join(' AND ');
  return sequelize.literal(`(${conditions})`);
};

/**
 * Create a where clause for users with exactly the specified permissions (no more, no less)
 * @param permissions - Array of permission flags that should be set
 * @returns Sequelize literal for the where clause
 */
export const whereExactPermissions = (permissions: bigint[]): Literal => {
  const requiredFlags = permissions.reduce((acc, permission) => acc | permission, 0n);
  return sequelize.literal(`permissionFlags = ${requiredFlags}`);
};

/**
 * Create a where clause for users with permissions in a specific range
 * @param minPermissions - Minimum permissions that must be present
 * @param maxPermissions - Maximum permissions that can be present (optional)
 * @returns Sequelize literal for the where clause
 */
export const wherePermissionRange = (minPermissions: bigint[], maxPermissions?: bigint[]): Literal => {
  const minFlags = minPermissions.reduce((acc, permission) => acc | permission, 0n);
  let condition = `(permissionFlags & ${minFlags}) = ${minFlags}`;

  if (maxPermissions) {
    const maxFlags = maxPermissions.reduce((acc, permission) => acc | permission, 0n);
    condition += ` AND (permissionFlags & ~${maxFlags}) = 0`;
  }

  return sequelize.literal(`(${condition})`);
};

/**
 * Get all permission flags as an object with their names
 * @param user - User object or permission flags
 */
export const getPermissionNames = (user: PermissionInput): string[] => {
  const flags = extractPermissionFlags(user);
  const names: string[] = [];

  Object.entries(permissionFlags).forEach(([name, flag]) => {
    if ((flags & flag) === flag) {
      names.push(name);
    }
  });

  return names;
};

/**
 * Convert permission flags to a readable string
 * @param user - User object or permission flags
 */
export const permissionFlagsToString = (user: PermissionInput): string => {
  return getPermissionNames(user).join(', ');
};

/**
 * Set or unset a specific permission for a user
 * @param user - User model instance or user attributes
 * @param permission - The permission flag to set/unset
 * @param value - true to add the permission, false to remove it
 * @returns The new permission flags value
 */
export const setUserPermission = (user: User | UserAttributes, permission: bigint, value: boolean): bigint => {
  const currentFlags = extractPermissionFlags(user);

  if (value) {
    return addPermission(currentFlags, permission);
  } else {
    return removePermission(currentFlags, permission);
  }
};

/**
 * Set or unset a specific permission for a user and update the database
 * @param user - User model instance
 * @param permission - The permission flag to set/unset
 * @param value - true to add the permission, false to remove it
 * @param transaction - Optional database transaction
 * @returns Promise that resolves when the update is complete
 */
export const setUserPermissionAndSave = async (
  user: User,
  permission: bigint,
  value: boolean,
  transaction?: Transaction
): Promise<void> => {
  const newFlags = setUserPermission(user, permission, value);
  await user.update({
    permissionFlags: newFlags,
    permissionVersion: (user.permissionVersion || 0) + 1
  }, { transaction });
};
