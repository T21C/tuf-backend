import { CDN_CONFIG, PUBLIC_CDN_BASE_URL, stripCdnBaseUrl } from '@/externalServices/cdnService/config.js';
import { ILevel } from '@/server/interfaces/models/index.js';
import LevelCredit from '@/models/levels/LevelCredit.js';

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
export function clampFloat(value: number, maxDecimals: number = 2) {
  if (value === null || value === undefined) return "1.0";
  return parseFloat(Number(value).toFixed(maxDecimals)).toString();
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

/** Escape untrusted text before interpolating it into HTML. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

export { stripCdnBaseUrl };

/** Origin this process may write/delete (`CDN_URL`). */
export function cdnWritableBaseUrl(): string {
  return stripCdnBaseUrl(String(CDN_CONFIG.baseUrl || ''));
}

/**
 * Origins treated as TUF CDN for rankings / eligibility / UI.
 * When `CDN_URL` is not production (`https://api.tuforums.com/cdn`), that public
 * origin is aliased so a local DB copy of prod `dlLink`s still counts — mutations
 * stay on {@link cdnWritableBaseUrl} only.
 */
export function cdnRecognitionPrefixes(): string[] {
  const writable = cdnWritableBaseUrl();
  const pub = stripCdnBaseUrl(PUBLIC_CDN_BASE_URL);
  const prefixes: string[] = [];
  if (writable) prefixes.push(writable);
  if (pub && pub !== writable) prefixes.push(pub);
  return prefixes;
}

export function urlMatchesCdnPrefix(url: string, prefix: string): boolean {
  if (!url || !prefix) return false;
  return url === prefix || url.startsWith(`${prefix}/`);
}

/** True if the URL is hosted on this environment's writable CDN (`CDN_URL`). */
export function isWritableCdnUrl(url: string): boolean {
  const writable = cdnWritableBaseUrl();
  return writable.length > 0 && urlMatchesCdnPrefix(url, writable);
}

/** True if the URL is a TUF CDN URL (writable origin, plus prod alias when they differ). */
export const isCdnUrl = (url: string): boolean => {
  if (!url) return false;
  return cdnRecognitionPrefixes().some((prefix) => urlMatchesCdnPrefix(url, prefix));
};

/** Hosted TUF CDN zip: present, not the `removed` sentinel, and `isCdnUrl`. */
export function hasDomesticCdnFile(dlLink: unknown): boolean {
  return typeof dlLink === 'string' && dlLink !== '' && dlLink !== 'removed' && isCdnUrl(dlLink);
}

function isExternallyAvailableFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

/** Ranked eligibility: domestic CDN zip or super-admin `isExternallyAvailable`. */
export function levelCountsForRanked(level: {
  dlLink?: unknown;
  isExternallyAvailable?: unknown;
} | null | undefined): boolean {
  if (!level) return false;
  return isExternallyAvailableFlag(level.isExternallyAvailable) || hasDomesticCdnFile(level.dlLink);
}

/**
 * SQL boolean matching {@link hasDomesticCdnFile} for a `dlLink` column.
 * Bind `:cdnPrefix` / `:cdnPrefixAlias` via {@link cdnSqlPrefixReplacements}.
 */
export function sqlDlLinkIsDomesticCdn(columnSql: string): string {
  return `(${columnSql} IS NOT NULL AND ${columnSql} != '' AND ${columnSql} != 'removed' AND (${columnSql} LIKE CONCAT(:cdnPrefix, '%') OR ${columnSql} LIKE CONCAT(:cdnPrefixAlias, '%')))`;
}

/**
 * SQL boolean matching {@link levelCountsForRanked}.
 * Bind CDN prefixes via {@link cdnSqlPrefixReplacements}.
 */
export function sqlLevelCountsForRanked(dlLinkSql: string, externalSql: string): string {
  return `(IFNULL(${externalSql}, 0) = 1 OR ${sqlDlLinkIsDomesticCdn(dlLinkSql)})`;
}

/** Sequelize replacements for {@link sqlDlLinkIsDomesticCdn}. Alias equals prefix when they match. */
export function cdnSqlPrefixReplacements(): {cdnPrefix: string; cdnPrefixAlias: string} {
  const prefixes = cdnRecognitionPrefixes();
  const fallback = prefixes[0] ?? '';
  return {
    cdnPrefix: prefixes[0] ?? '',
    cdnPrefixAlias: prefixes[1] ?? fallback,
  };
}

// Helper function to extract file ID from CDN URL
export const getFileIdFromCdnUrl = (url: string): string | null => {
  if (!isCdnUrl(url)) return null;

  const regex = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/g;
  const matches = [...url.matchAll(regex)];
  if (matches.length !== 1) return null; // Only allow a single UUID occurrence
  return matches[0][1];
};

const ICON_SIZE_SEGMENT_RE = /\/(?:small|medium|large|original)(?=\/|\.|\?|#|$)/gi;

/** Swap CDN icon size path segment. No-op when the URL has no size token. */
export function selectIconSize(
  url: string | null | undefined,
  size: 'small' | 'medium' | 'large' | 'original' = 'small',
): string | null {
  if (url == null || url === '') return null;
  const token = size === 'medium' || size === 'large' || size === 'original' ? size : 'small';
  return url.replace(ICON_SIZE_SEGMENT_RE, `/${token}`);
}



export function formatCredits(credits: string[] | undefined): string {
  const sliceLength = 3;

  if (!credits) return '';
  return credits.length > sliceLength ?
    credits.slice(0, sliceLength).join(', ') + ' and ' + (credits.length - sliceLength) + ' more'
    : credits.join(', ');
}

export type CreditOrderable = {
  sortOrder?: number | null;
  id?: number | null;
};

export function compareLevelCreditOrder(a: CreditOrderable, b: CreditOrderable): number {
  const ao = Number(a?.sortOrder);
  const bo = Number(b?.sortOrder);
  const aOk = Number.isFinite(ao);
  const bOk = Number.isFinite(bo);
  if (aOk && bOk && ao !== bo) return ao - bo;
  if (aOk !== bOk) return aOk ? -1 : 1;
  return 0;
}

export function sortLevelCredits<T extends CreditOrderable>(
  credits: T[] | null | undefined,
): T[] {
  if (!Array.isArray(credits)) return [];
  return credits
    .map((credit, index) => ({credit, index}))
    .sort((a, b) => {
      const byOrder = compareLevelCreditOrder(a.credit, b.credit);
      return byOrder !== 0 ? byOrder : a.index - b.index;
    })
    .map(({credit}) => credit);
}

export const formatCreatorDisplay = (level: ILevel) => {
  // If team exists, it takes priority
  if (!level) return '';

  if (level.team) {
    return level.team;
  }

  const sortedCredits = sortLevelCredits(level.levelCredits);
  // If no credits, fall back to creator field
  if (sortedCredits.length === 0) {
    return 'No credits';
  }

  // Group credits by role, preserving sortOrder within each role
  const creditsByRole = sortedCredits.reduce((acc: Record<string, string[]>, credit: LevelCredit) => {
    const role = String(credit.role ?? '').toLowerCase();
    if (!role) return acc;
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
  const primaryCount = charters.length + vfxers.length;

  if (primaryCount >= 3) {
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
  } else if (primaryCount === 2) {
    if (charters.length === 2) {
      return `${charters[0]} & ${charters[1]}`;
    }
    if (charters.length === 1 && vfxers.length === 1) {
      return `${charters[0]} | ${vfxers[0]}`;
    }
  }

  return charters[0] || vfxers[0] || 'No credits';
};
