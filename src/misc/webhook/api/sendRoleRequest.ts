import fetch from 'node-fetch';
import { Response } from 'node-fetch';

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second
const REQUEST_TIMEOUT = 10000; // 10 seconds
const DISCORD_API_BASE = 'https://discord.com/api/v10';

const isRetryableError = (error: any): boolean => {
  const errorMessage = error?.message?.toLowerCase() || '';
  const errorCode = error?.code?.toLowerCase() || '';

  return (
    errorMessage.includes('socket hang up') ||
    errorMessage.includes('econnreset') ||
    errorMessage.includes('etimedout') ||
    errorMessage.includes('timeout') ||
    errorCode === 'econnreset' ||
    errorCode === 'etimedout' ||
    errorCode === 'econnrefused'
  );
};

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

export interface DiscordRoleRequestOptions {
  botToken: string;
  guildId: string;
  userId: string;
  roleId: string;
  reason?: string;
}

/**
 * Send a role add request to Discord API
 */
export const addDiscordRole = async (
  options: DiscordRoleRequestOptions,
  retryCount = 0
): Promise<Response> => {
  const { botToken, guildId, userId, roleId, reason } = options;
  const url = `${DISCORD_API_BASE}/guilds/${guildId}/members/${userId}/roles/${roleId}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const headers: Record<string, string> = {
      'Authorization': `Bot ${botToken}`,
      'Content-Type': 'application/json',
    };

    if (reason) {
      headers['X-Audit-Log-Reason'] = encodeURIComponent(reason);
    }

    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle rate limiting
      if (response.status === 429) {
        const body: any = await response.json();
        const retryAfter = body.retry_after * 1000; // Convert to ms
        await delay(retryAfter);
        return addDiscordRole(options, retryCount);
      }

      return response;
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      throw fetchError;
    }
  } catch (error: any) {
    if (isRetryableError(error) && retryCount < MAX_RETRIES) {
      const delayMs = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
      await delay(delayMs);
      return addDiscordRole(options, retryCount + 1);
    }
    throw error;
  }
};

/**
 * Send a role remove request to Discord API
 */
export const removeDiscordRole = async (
  options: DiscordRoleRequestOptions,
  retryCount = 0
): Promise<Response> => {
  const { botToken, guildId, userId, roleId, reason } = options;
  const url = `${DISCORD_API_BASE}/guilds/${guildId}/members/${userId}/roles/${roleId}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const headers: Record<string, string> = {
      'Authorization': `Bot ${botToken}`,
      'Content-Type': 'application/json',
    };

    if (reason) {
      headers['X-Audit-Log-Reason'] = encodeURIComponent(reason);
    }

    try {
      const response = await fetch(url, {
        method: 'DELETE',
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle rate limiting
      if (response.status === 429) {
        const body: any = await response.json();
        const retryAfter = body.retry_after * 1000; // Convert to ms
        await delay(retryAfter);
        return removeDiscordRole(options, retryCount);
      }

      return response;
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      throw fetchError;
    }
  } catch (error: any) {
    if (isRetryableError(error) && retryCount < MAX_RETRIES) {
      const delayMs = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
      await delay(delayMs);
      return removeDiscordRole(options, retryCount + 1);
    }
    throw error;
  }
};

/**
 * Get member info from Discord API (including roles)
 */
export const getDiscordMember = async (
  botToken: string,
  guildId: string,
  userId: string,
  retryCount = 0
): Promise<Response> => {
  const url = `${DISCORD_API_BASE}/guilds/${guildId}/members/${userId}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bot ${botToken}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle rate limiting
      if (response.status === 429) {
        const body: any = await response.json();
        const retryAfter = body.retry_after * 1000; // Convert to ms
        await delay(retryAfter);
        return getDiscordMember(botToken, guildId, userId, retryCount);
      }

      return response;
    } catch (fetchError: any) {
      clearTimeout(timeoutId);
      throw fetchError;
    }
  } catch (error: any) {
    if (isRetryableError(error) && retryCount < MAX_RETRIES) {
      const delayMs = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
      await delay(delayMs);
      return getDiscordMember(botToken, guildId, userId, retryCount + 1);
    }
    throw error;
  }
};

export default { addDiscordRole, removeDiscordRole, getDiscordMember };
