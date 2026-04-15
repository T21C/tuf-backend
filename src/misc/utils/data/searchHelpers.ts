import {Op} from 'sequelize';

type SearchCondition = {
  [key: string]: {
    [Op.like]?: string;
    [Op.eq]?: string;
  };
};

type MultiSearchResult = {
  conditions: SearchCondition[];
};

// Private Use Area (PUA) character mappings
const SPECIAL_CHAR_MAP = {
  '*': '\uE000', // Asterisk
  '%': '\uE001', // Percent
  '+': '\uE002', // Plus
  '-': '\uE003', // Minus
  '&': '\uE004', // Ampersand
  '|': '\uE005', // Vertical bar
  '!': '\uE006', // Exclamation mark
  '(': '\uE007', // Opening parenthesis
  ')': '\uE008', // Closing parenthesis
  '{': '\uE009', // Opening brace
  '}': '\uE00A', // Closing brace
  '[': '\uE00B', // Opening bracket
  ']': '\uE00C', // Closing bracket
  '^': '\uE00D', // Caret
  '"': '\uE00E', // Double quote
  '~': '\uE00F', // Tilde
  ':': '\uE010', // Colon
  ' ': '\uE011', // Space
  '`': '\uE012', // Backtick
  '=': '\uE013', // Equals sign
  '<': '\uE014', // Less than
  '>': '\uE015', // Greater than
  '?': '\uE016', // Question mark
  '/': '\uE017', // Slash
  '\\': '\uE018', // Backslash
} as const;

// Reverse mapping for converting back
const PUA_CHAR_MAP = Object.entries(SPECIAL_CHAR_MAP).reduce((acc, [key, value]) => {
  acc[value] = key;
  return acc;
}, {} as Record<string, string>);

/**
 * Creates a search condition for a field that properly handles special characters
 * @param field The field to search in
 * @param value The search value
 * @param exact Whether to do an exact match or a LIKE search
 * @returns A Sequelize where condition
 */
export function createSearchCondition(
  field: string,
  value: string,
  exact = false,
): SearchCondition {
  // Handle special characters in the search value
  const searchValue = exact ? value : `%${escapeForMySQL(value)}%`;

  return {
    [field]: {[exact ? Op.eq : Op.like]: searchValue},
  };
}

/**
 * Creates a multi-field search condition that properly handles special characters
 * @param fields Array of fields to search in
 * @param value The search value
 * @param exact Whether to do an exact match or a LIKE search
 * @returns A Sequelize where condition with OR conditions
 */
export function createMultiFieldSearchCondition(
  fields: string[],
  value: string,
  exact = false,
): MultiSearchResult {
  const searchValue = exact ? value : `%${escapeForMySQL(value)}%`;

  return {
    conditions: fields.map(field => ({
      [field]: {[exact ? Op.eq : Op.like]: searchValue},
    })),
  };
}

export function escapeForMySQL(str: string) {
  if (!str) return '';

  // eslint-disable-next-line no-control-regex
  return str.replace(/[\0\x08\x09\x1a\n\r"'%_\\]/g, char => {
    switch (char) {
      case '\0':
        return '\\0';
      case '\x08':
        return '\\b';
      case '\x09':
        return '\\t';
      case '\x1a':
        return '\\z';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '"':
      case "'":
      case '\\':
      case '%':
      case '_':
        return '\\' + char; // prepends a backslash to backslash, percent, and underscore
      default:
        return char;
    }
  });
}

/**
 * Converts special characters to PUA characters for indexing
 * @param str The string to convert
 * @returns The converted string with special characters replaced by PUA characters
 */
export function convertToPUA(str: string): string {
  if (!str) return '';

  // Create a regex pattern from all special characters
  const pattern = new RegExp(`[\\${Object.keys(SPECIAL_CHAR_MAP).join('\\')}]`, 'g');

  return str.replace(pattern, char => SPECIAL_CHAR_MAP[char as keyof typeof SPECIAL_CHAR_MAP] || char);
}

/**
 * Converts PUA characters back to their original special characters
 * @param str The string to convert
 * @returns The converted string with PUA characters replaced by original special characters
 */
export function convertFromPUA(str: string): string {
  if (!str) return '';

  // Create a regex pattern from all PUA characters
  const pattern = new RegExp(`[${Object.values(SPECIAL_CHAR_MAP).join('')}]`, 'g');

  return str.replace(pattern, char => PUA_CHAR_MAP[char] || char);
}

/**
 * Converts special characters in search terms to their PUA equivalents
 * @param str The search term to convert
 * @returns The converted search term
 */
export function prepareSearchTerm(str: string): string {
  if (!str) return '';

  // Convert special characters to PUA characters
  return convertToPUA(str)
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
}

/** Result of parsing a field value like `180`, `>100`, `<=200` for ES numeric fields. */
export type ParsedNumericSearchConstraint =
  | { kind: 'term'; n: number }
  | {
      kind: 'range';
      bounds: Partial<{ gt: number; gte: number; lt: number; lte: number }>;
    };

/**
 * Parse a numeric search operand (after field name), e.g. `180`, `>100`, `>=1.5`.
 * Pass the **decoded** string (use {@link convertFromPUA} when values come from the PUA query pipeline).
 */
export function parseNumericSearchConstraint(
  rawValue: string,
  options: { integerOnly?: boolean } = {},
): ParsedNumericSearchConstraint | null {
  const { integerOnly = false } = options;
  const t = rawValue.trim();
  const withOp = t.match(/^(>=|<=|>|<)\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*$/);
  if (withOp) {
    const op = withOp[1];
    const numStr = withOp[2];
    if (integerOnly) {
      if (numStr.includes('.') || /[eE]/.test(numStr)) return null;
      const num = parseInt(numStr, 10);
      if (!Number.isFinite(num)) return null;
      const bounds: Partial<{ gt: number; gte: number; lt: number; lte: number }> = {};
      if (op === '>') bounds.gt = num;
      else if (op === '<') bounds.lt = num;
      else if (op === '>=') bounds.gte = num;
      else bounds.lte = num;
      return { kind: 'range', bounds };
    }
    const num = parseFloat(numStr);
    if (!Number.isFinite(num)) return null;
    const bounds: Partial<{ gt: number; gte: number; lt: number; lte: number }> = {};
    if (op === '>') bounds.gt = num;
    else if (op === '<') bounds.lt = num;
    else if (op === '>=') bounds.gte = num;
    else bounds.lte = num;
    return { kind: 'range', bounds };
  }
  const plain = t.match(/^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*$/);
  if (!plain) return null;
  const numStr = plain[1];
  if (integerOnly) {
    if (numStr.includes('.') || /[eE]/.test(numStr)) return null;
    const num = parseInt(numStr, 10);
    if (!Number.isFinite(num)) return null;
    return { kind: 'term', n: num };
  }
  const num = parseFloat(numStr);
  if (!Number.isFinite(num)) return null;
  return { kind: 'term', n: num };
}

/** Concatenated tokens like `10m15s` (no space); try `ms` before `m`. No trailing `\b` after unit (would break `m`+digit). */
const DURATION_TOKEN_RE = /(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi;

/**
 * Parse a duration string into milliseconds for `time:` level search (chart length).
 * - With units: sum of `h` (hours), `m` (minutes), `s` (seconds), `ms` (milliseconds); alternation tries `ms` before `m`. Tokens may be concatenated (`10m15s`).
 * - Plain number with no units: milliseconds (same unit as `levelLengthInMs`).
 * - No leftover text after consuming unit tokens.
 */
export function parseDurationToMs(body: string): number | null {
  const t = body.trim();
  if (!t) return null;

  const plain = t.match(/^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/);
  if (plain) {
    const n = parseFloat(plain[0]);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }

  let total = 0;
  const re = new RegExp(DURATION_TOKEN_RE.source, DURATION_TOKEN_RE.flags);
  const matches = [...t.matchAll(re)];
  if (matches.length === 0) return null;

  for (const m of matches) {
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    const u = m[2].toLowerCase();
    if (u === 'ms') total += n;
    else if (u === 'h') total += n * 3600000;
    else if (u === 'm') total += n * 60000;
    else if (u === 's') total += n * 1000;
    else return null;
  }

  const stripped = t.replace(new RegExp(DURATION_TOKEN_RE.source, DURATION_TOKEN_RE.flags), '').replace(/\s+/g, '');
  if (stripped !== '') return null;
  if (!Number.isFinite(total) || total < 0) return null;
  return total;
}

/**
 * Parse `time:` search values for chart length (`levelLengthInMs`), e.g. `>10m15s`, `<50s`, `2m`, `130000` (ms).
 * Pass the **decoded** string (use {@link convertFromPUA} when values come from the PUA query pipeline).
 */
export function parseDurationSearchConstraint(rawValue: string): ParsedNumericSearchConstraint | null {
  const t = rawValue.trim();
  const opMatch = t.match(/^(>=|<=|>|<)\s*(.+)$/);
  const op = opMatch ? opMatch[1] : null;
  const body = (opMatch ? opMatch[2] : t).trim();
  if (!body) return null;

  const ms = parseDurationToMs(body);
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;

  if (!op) {
    return { kind: 'term', n: ms };
  }
  const bounds: Partial<{ gt: number; gte: number; lt: number; lte: number }> = {};
  if (op === '>') bounds.gt = ms;
  else if (op === '<') bounds.lt = ms;
  else if (op === '>=') bounds.gte = ms;
  else bounds.lte = ms;
  return { kind: 'range', bounds };
}
