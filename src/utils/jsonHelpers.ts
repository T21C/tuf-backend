/**
 * Utility functions for handling JSON serialization with BigInt values
 */

/**
 * Recursively converts BigInt values to strings in an object for safe JSON serialization
 * @param obj - Object to serialize
 * @returns Object with BigInt values converted to strings
 */
export function serializeBigInt(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'bigint') {
    return obj.toString();
  }

  if (Array.isArray(obj)) {
    return obj.map(serializeBigInt);
  }

  if (typeof obj === 'object') {
    const serialized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      serialized[key] = serializeBigInt(value);
    }
    return serialized;
  }

  return obj;
}

/**
 * Helper function to safely serialize a user object with BigInt permissionFlags
 * @param user - User object to serialize
 * @returns Serialized user object with permissionFlags as string
 */
export function serializeUser(user: any): any {
  if (!user) return null;

  const userJson = user.toJSON ? user.toJSON() : user;

  return {
    ...userJson,
    permissionFlags: user.permissionFlags ? user.permissionFlags.toString() : '0'
  };
}

/**
 * Helper function to safely serialize a player object with potential user BigInt values
 * @param player - Player object to serialize
 * @returns Serialized player object with BigInt values converted to strings
 */
export function serializePlayer(player: any): any {
  if (!player) return null;

  const playerJson = player.toJSON ? player.toJSON() : player;

  return {
    ...playerJson,
    user: player.user ? serializeUser(player.user) : null
  };
}

/**
 * Custom JSON.stringify replacer function for BigInt values
 * @param key - Property key
 * @param value - Property value
 * @returns Serialized value
 */
export function bigIntReplacer(key: string, value: any): any {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
}

/**
 * Safe JSON.stringify that handles BigInt values
 * @param obj - Object to stringify
 * @param space - Optional space parameter for formatting
 * @returns JSON string with BigInt values converted to strings
 */
export function safeStringify(obj: any, space?: string | number): string {
  return JSON.stringify(obj, bigIntReplacer, space);
}
