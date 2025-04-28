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
  
  return str.replace(/[\0\x08\x09\x1a\n\r"'\\\%\_]/g, char => {
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