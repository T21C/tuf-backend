import { CDN_CONFIG } from '../cdnService/config.js';

export function validateFeelingRating(value: string) {
  const exprPattern1 = '[PGUpgu][1-9]'; // Handles single letters followed by 1-9
  const exprPattern2 = '[PGUpgu]1[0-9]'; // Handles single letters followed by 10-19
  const exprPattern3 = '[PGUpgu]20'; // Handles single letters followed by 20

  const pguRegex = `(${exprPattern1}|${exprPattern2}|${exprPattern3})`;

  const rangeRegex = `^${pguRegex}(~|-)${pguRegex}$`;

  const legacyRegex =
    '^([1-9]|1[0-7])$|^(1[8-9]\\+?)$|^(20(\\.[0-9])?\\+?)$|^(21(\\.[0-4])?\\+?)$';

  const legacyRange =
    '^(([1-9]|1[0-7])|(1[8-9]\\+?)|(20(\\.[0-9])?\\+?)|(21(\\.[0-4])?\\+?))(~|-)(([1-9]|1[0-7])|(1[8-9]\\+?)|(20(\\.[0-9])?\\+?)|(21(\\.[0-4])?\\+?))$';

  const regex = new RegExp(
    `^$|^${pguRegex}$|^-2$|^${rangeRegex}$|^${legacyRegex}$|^${legacyRange}$|^Censored$|^Impossible$`,
  );

  return regex.test(value);
}

export function validateSpeed(value: string) {
  const regex = new RegExp('^$|^1(.[0-9]+)?$');
  return regex.test(value);
}

export function validateNumber(value: string) {
  const regex = new RegExp('^\\d+$');
  return regex.test(value);
}
export function formatSpeed(speed: number) {
  const speedTwoDecimals = speed.toFixed(2);
  if (speedTwoDecimals[speedTwoDecimals.length - 1] !== '0') {
    return speedTwoDecimals;
  }
  const speedOneDecimal = speed.toFixed(1);
  if (speedOneDecimal[speedOneDecimal.length - 1] !== '0') {
    return speedOneDecimal;
  }
  return Math.round(speed);
}

export function formatScore(score: number) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(score);
}

export function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const ensureString = (value: any): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0]?.toString();
  if (value?.toString) return value.toString();
  return undefined;
};

export const sanitizeTextInput = (input: string | null | undefined): string => {
  if (input === null || input === undefined) return '';
  return input.trim();
};

/**
 * Wraps a database operation with transaction state validation
 * @param transaction - The transaction to check
 * @param operation - The database operation to perform
 * @param operationName - Name of the operation for error messages
 * @returns The result of the operation
 */
export const withTransactionCheck = async <T>(
  transaction: any,
  operation: () => Promise<T>,
  operationName: string
): Promise<T> => {
  if (!isTransactionUsable(transaction)) {
    throw new Error(`Transaction is no longer usable before ${operationName}`);
  }

  const result = await operation();

  if (!isTransactionUsable(transaction)) {
    throw new Error(`Transaction is no longer usable after ${operationName} - likely rolled back due to a database error`);
  }

  return result;
};

/**
 * Checks if a transaction is still usable (not finished/rolled back)
 * @param transaction - The transaction to check
 * @returns true if transaction is still usable, false otherwise
 */
export const isTransactionUsable = (transaction: any): boolean => {
  if (!transaction) return false;

  // Check if transaction is finished (committed or rolled back)
  if (transaction.finished) return false;

  // Check if transaction has been rolled back
  if (transaction.rolledBack) return false;

  // Additional check for transaction state
  try {
    // Try to access transaction properties to see if it's still valid
    return transaction.id && !transaction.ended;
  } catch (error) {
    // If we can't access transaction properties, it's likely not usable
    return false;
  }
};

/**
 * Safely rolls back a transaction, handling cases where it has already been rolled back
 * @param transaction - The transaction to rollback
 * @param logger - Logger instance for error logging
 * @returns true if rollback was successful, false if it was already rolled back
 */
export const safeTransactionRollback = async (transaction: any, logger?: any): Promise<boolean> => {
  if (!transaction) return false;

  // Check if transaction is already finished
  if (transaction.finished) {
    if (logger) {
      logger.debug('Transaction already finished, skipping rollback');
    }
    return false;
  }

  try {
    await transaction.rollback();
    return true;
  } catch (error) {
    if (logger) {
      logger.warn('Transaction rollback failed (likely already rolled back):', error);
    }
    // Don't throw the error - this is expected behavior when transaction is already rolled back
    return false;
  }
};

// Helper function to check if a URL is from our CDN
export const isCdnUrl = (url: string): boolean => {
  return url.startsWith(CDN_CONFIG.baseUrl);
};

// Helper function to extract file ID from CDN URL
export const getFileIdFromCdnUrl = (url: string): string | null => {
  if (!isCdnUrl(url)) return null;

  const regex = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/;
  const match = url.match(regex);
  return match ? match[1] : null;
};
