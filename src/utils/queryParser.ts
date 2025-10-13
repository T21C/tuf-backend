import { logger } from '../services/LoggerService.js';

// Type definitions for query parsing
export type FieldSearch = {
  field: string;
  value: string;
  exact: boolean;
  isNot: boolean;
};

export type SearchGroup = {
  terms: FieldSearch[];
  operation: 'AND' | 'OR';
};

export type QueryParserConfig = {
  allowedFields: string[];
  numericFields?: string[]; // Fields that contain numeric values
  isPassSearch?: boolean;
};

/**
 * Parses a single search term to extract field, value, and search type
 * @param term - The search term to parse
 * @param config - Configuration for allowed fields and search type
 * @returns Parsed field search object or null if invalid
 */
export const parseFieldSearch = (term: string, config: QueryParserConfig): FieldSearch | null => {
  // Trim the term here when parsing
  const trimmedTerm = term.trim();
  if (!trimmedTerm) return null;

  // Check for NOT operator
  const isNot = trimmedTerm.startsWith('\\!');
  const searchTerm = isNot ? trimmedTerm.slice(2) : trimmedTerm;

  // Check for exact match with equals sign
  const exactMatch = searchTerm.match(new RegExp(`^(${config.allowedFields.join('|')})=(.+)$`, 'i'));
  if (exactMatch) {
    const field = exactMatch[1].toLowerCase();
    const value = exactMatch[2].trim();
    logger.debug(`Exact match search - Field: ${field}, Value: ${value}`);
    return {
      field,
      value,
      exact: true,
      isNot
    };
  }

  // Check for partial match with colon
  const partialMatch = searchTerm.match(new RegExp(`^(${config.allowedFields.join('|')}):(.+)$`, 'i'));
  if (partialMatch) {
    const field = partialMatch[1].toLowerCase();
    const value = partialMatch[2].trim();
    logger.debug(`Partial match search - Field: ${field}, Value: ${value}`);
    return {
      field,
      value,
      exact: false,
      isNot
    };
  }

  // Handle general search term with NOT operator
  logger.debug(`General search - Value: ${searchTerm.trim()}`);
  return {
    field: 'any',
    value: searchTerm.trim(),
    exact: false,
    isNot
  };
};

/**
 * Parses a complete search query string into search groups
 * @param query - The search query string
 * @param config - Configuration for allowed fields and search type
 * @returns Array of search groups
 */
export const parseSearchQuery = (query: string, config: QueryParserConfig): SearchGroup[] => {
  if (!query) return [];

  // Split by | for OR groups and handle trimming here
  const groups = query
    .split('|')
    .map(group => {
      // Split by comma for AND terms within each group
      const terms = group
        .split(',')
        .map(term => term.trim())
        .filter(term => term.length > 0)
        .map(term => {
          const fieldSearch = parseFieldSearch(term, config);
          if (fieldSearch) {
            return fieldSearch;
          }
          return {
            field: 'any',
            value: term.trim(),
            exact: false,
            isNot: false
          };
        });

      return {
        terms,
        operation: 'AND' as const,
      };
    })
    .filter(group => group.terms.length > 0); // Remove empty groups

  return groups;
};

/**
 * Extracts specific field values from parsed search groups
 * @param searchGroups - Array of parsed search groups
 * @param fieldName - The field name to extract
 * @returns Array of values for the specified field
 */
export const extractFieldValues = (searchGroups: SearchGroup[], fieldName: string): string[] => {
  const values: string[] = [];
  
  for (const group of searchGroups) {
    for (const term of group.terms) {
      if (term.field === fieldName) {
        values.push(term.value);
      }
    }
  }
  
  return values;
};

/**
 * Extracts general search terms (field === 'any') from parsed search groups
 * @param searchGroups - Array of parsed search groups
 * @returns Array of general search terms
 */
export const extractGeneralSearchTerms = (searchGroups: SearchGroup[]): string[] => {
  const terms: string[] = [];
  
  for (const group of searchGroups) {
    for (const term of group.terms) {
      if (term.field === 'any') {
        terms.push(term.value);
      }
    }
  }
  
  return terms;
};

/**
 * Configuration presets for different search types
 */
export const queryParserConfigs = {
  level: {
    allowedFields: ['id', 'song', 'artist', 'charter', 'team', 'vfxer', 'creator', 'dlLink', 'legacyDllink', 'videolink'],
    numericFields: ['id']
  },
  pass: {
    allowedFields: ['player', 'video', 'vidtitle', 'level.song', 'level.artist', 'level.dlLink'],
    numericFields: [] as string[],
    isPassSearch: true
  },
  pack: {
    allowedFields: ['name', 'owner', 'levelId', 'viewMode', 'pinned'],
    numericFields: ['levelId']
  }
};
