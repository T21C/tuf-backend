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

export const escapeForMySQL = (str: string) => {
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
};

/**
 * Converts special characters to PUA characters for indexing
 * @param str The string to convert
 * @returns The converted string with special characters replaced by PUA characters
 */
export const convertToPUA = (str: string): string => {
  if (!str) return '';

  // Create a regex pattern from all special characters
  const pattern = new RegExp(`[\\${Object.keys(SPECIAL_CHAR_MAP).join('\\')}]`, 'g');

  return str.replace(pattern, char => SPECIAL_CHAR_MAP[char as keyof typeof SPECIAL_CHAR_MAP] || char);
};

/**
 * Converts PUA characters back to their original special characters
 * @param str The string to convert
 * @returns The converted string with PUA characters replaced by original special characters
 */
export const convertFromPUA = (str: string): string => {
  if (!str) return '';

  // Create a regex pattern from all PUA characters
  const pattern = new RegExp(`[${Object.values(SPECIAL_CHAR_MAP).join('')}]`, 'g');

  return str.replace(pattern, char => PUA_CHAR_MAP[char] || char);
};

/**
 * Converts special characters in search terms to their PUA equivalents
 * @param str The search term to convert
 * @returns The converted search term
 */
export const prepareSearchTerm = (str: string): string => {
  if (!str) return '';

  // Convert special characters to PUA characters
  return convertToPUA(str)
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
};
