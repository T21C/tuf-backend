import { logger } from '@/server/services/core/LoggerService.js';

/**
 * Forgiving JSON parser for values that may arrive as raw strings (multipart)
 * or as already-parsed objects (express.json). Returns null on parse failure.
 */
export function safeParseJSON<T = unknown>(input: string | object | null | undefined): T | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'object') return input as T;
  try {
    return JSON.parse(input) as T;
  } catch (error) {
    logger.error('Failed to parse JSON:', {
      error: error instanceof Error ? error.message : String(error),
      input: typeof input === 'string' ? input.substring(0, 100) : input,
      timestamp: new Date().toISOString(),
    });
    return null;
  }
}
