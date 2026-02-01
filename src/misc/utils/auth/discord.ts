import fetch, {Headers as NodeFetchHeaders} from 'node-fetch';
import { logger } from '../../../server/services/LoggerService.js';

interface DiscordUserInfo {
  id: string;
  username: string;
  avatar: string | null;
}

interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
  resetAfter: number;
  bucket: string;
}

// Track rate limits per bucket
const rateLimits = new Map<string, RateLimitInfo>();

function parseRateLimitHeaders(
  headers: NodeFetchHeaders,
): RateLimitInfo | null {
  const limit = headers.get('x-ratelimit-limit');
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  const resetAfter = headers.get('x-ratelimit-reset-after');
  const bucket = headers.get('x-ratelimit-bucket');

  if (!limit || !remaining || !reset || !resetAfter || !bucket) {
    return null;
  }

  return {
    limit: parseInt(limit),
    remaining: parseInt(remaining),
    reset: parseInt(reset),
    resetAfter: parseFloat(resetAfter),
    bucket,
  };
}

async function handleRateLimit(bucket: string): Promise<void> {
  const rateLimit = rateLimits.get(bucket);
  if (!rateLimit || rateLimit.remaining > 0) return;

  const now = Date.now() / 1000;
  const waitTime = Math.max(0, rateLimit.reset - now) * 1000;

  if (waitTime > 0) {
    logger.debug(`Rate limit hit for bucket ${bucket}, waiting ${waitTime}ms`);
    await new Promise(resolve => setTimeout(resolve, waitTime + 100)); // Add 100ms buffer
  }
}

class DiscordAPIError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'DiscordAPIError';
    this.status = status;
  }
}

export async function fetchDiscordUserInfo(userId: string): Promise<{
  username: string;
  avatar: string | null;
}> {
  const endpoint = `https://discord.com/api/v10/users/${userId}`;

  // Get the current bucket's rate limit info
  const bucket = `users-${userId}`;
  await handleRateLimit(bucket);

  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
    },
  });

  // Update rate limit info
  const rateLimitInfo = parseRateLimitHeaders(response.headers);
  if (rateLimitInfo) {
    rateLimits.set(bucket, rateLimitInfo);
  }

  // Handle rate limit response
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const waitTime = parseInt(retryAfter) * 1000;
      logger.debug(`Rate limited by Discord API, waiting ${waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return fetchDiscordUserInfo(userId); // Retry the request
    }
  }

  if (!response.ok) {
    logger.error(JSON.stringify(response));
    throw new DiscordAPIError(
      `Failed to fetch Discord user info: ${response.statusText}`,
      response.status
    );
  }

  const data = (await response.json()) as DiscordUserInfo;

  return data;
}
