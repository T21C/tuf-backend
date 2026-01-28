import { CDN_CONFIG } from '../../externalServices/cdnService/config.js';
import { ILevel } from '../../server/interfaces/models/index.js';
import LevelCredit from '../../models/levels/LevelCredit.js';

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
    `^$|^${pguRegex}$|^-2$|^${rangeRegex}$|^${legacyRegex}$|^${legacyRange}$|^Censored$|^Impossible$|^P0$`,
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

  const regex = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/g;
  const matches = [...url.matchAll(regex)];
  if (matches.length !== 1) return null; // Only allow a single UUID occurrence
  return matches[0][1];
};



export function formatCredits(credits: string[] | undefined): string {
  const sliceLength = 3;

  if (!credits) return '';
  return credits.length > sliceLength ?
    credits.slice(0, sliceLength).join(', ') + ' and ' + (credits.length - sliceLength) + ' more'
    : credits.join(', ');
}


export const formatCreatorDisplay = (level: ILevel) => {
  // If team exists, it takes priority
  if (!level) return '';

  if (level.team) {
    return level.team;
  }

  // If no credits, fall back to creator field
  if (!level.levelCredits || level.levelCredits.length === 0) {
    return 'No credits';
  }

  // Group credits by role
  const creditsByRole = level.levelCredits.reduce((acc: Record<string, string[]>, credit: LevelCredit) => {
    const role = credit.role.toLowerCase();
    if (!acc[role]) {
      acc[role] = [];
    }
    if (credit.creator?.name) {
      acc[role].push(credit.creator?.name);
    }
    return acc;
  }, {});

  const charters = creditsByRole['charter'] || [];
  const vfxers = creditsByRole['vfxer'] || [];

  // Handle different cases based on number of credits
  if (level.levelCredits.length >= 3) {
    const parts = [];
    if (charters.length > 0) {
      parts.push(charters.length === 1
        ? charters[0]
        : `${charters[0]} & ${charters.length - 1} more`);
    }
    if (vfxers.length > 0) {
      parts.push(vfxers.length === 1
        ? vfxers[0]
        : `${vfxers[0]} & ${vfxers.length - 1} more`);
    }
    return parts.join(' | ');
  } else if (level.levelCredits.length === 2) {
    if (charters.length === 2) {
      return `${charters[0]} & ${charters[1]}`;
    }
    if (charters.length === 1 && vfxers.length === 1) {
      return `${charters[0]} | ${vfxers[0]}`;
    }
  }

  return level.levelCredits[0]?.creator?.name || 'No credits';
};
