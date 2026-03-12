import {NextFunction, Request, Response} from 'express';

const MAX_QUERY_STRING_LENGTH = 255;
const MAX_LIMIT = 200;
const MAX_OFFSET = 1_000_000;
const MAX_PAGE = 100_000;

type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | QueryValue[]
  | {[key: string]: QueryValue};

const PAGINATION_DEFAULTS = {
  page: 1,
  limit: 30,
  offset: 0,
} as const;

const PAGINATION_CONSTRAINTS = {
  page: {min: 1, max: MAX_PAGE},
  limit: {min: 1, max: MAX_LIMIT},
  offset: {min: 0, max: MAX_OFFSET},
} as const;

function normalizePaginationValue(key: keyof typeof PAGINATION_CONSTRAINTS, value: unknown): number {
  const stringValue = String(value).trim();
  const parsedValue = Number(stringValue);

  if (!Number.isFinite(parsedValue)) {
    return PAGINATION_DEFAULTS[key];
  }

  const normalizedValue = Math.trunc(parsedValue);
  const {min, max} = PAGINATION_CONSTRAINTS[key];

  return Math.min(Math.max(normalizedValue, min), max);
}

function sanitizeQueryValue(
  key: string,
  value: QueryValue,
  path: string[] = [],
): {value?: QueryValue; error?: string} {
  const currentPath = [...path, key].filter(Boolean).join('.');

  if (value == null) {
    return {value};
  }

  if (Array.isArray(value)) {
    if (key in PAGINATION_CONSTRAINTS) {
      return {error: `Invalid query parameter "${currentPath}"`};
    }

    const sanitizedArray: QueryValue[] = [];
    for (const item of value) {
      const result = sanitizeQueryValue(key, item, path);
      if (result.error) {
        return result;
      }
      sanitizedArray.push(result.value as QueryValue);
    }
    return {value: sanitizedArray};
  }

  if (typeof value === 'object') {
    const sanitizedObject: {[key: string]: QueryValue} = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const result = sanitizeQueryValue(childKey, childValue as QueryValue, [...path, key]);
      if (result.error) {
        return result;
      }
      sanitizedObject[childKey] = result.value as QueryValue;
    }
    return {value: sanitizedObject};
  }

  if (typeof value === 'string') {
    if (value.length > MAX_QUERY_STRING_LENGTH) {
      return {error: `Query parameter "${currentPath}" exceeds ${MAX_QUERY_STRING_LENGTH} characters`};
    }

    if (key in PAGINATION_CONSTRAINTS) {
      return {
        value: normalizePaginationValue(
          key as keyof typeof PAGINATION_CONSTRAINTS,
          value,
        ),
      };
    }
  }

  if (typeof value === 'number' && key in PAGINATION_CONSTRAINTS) {
    return {
      value: normalizePaginationValue(
        key as keyof typeof PAGINATION_CONSTRAINTS,
        value,
      ),
    };
  }

  return {value};
}

function applyPaginationDefaults(
  query: {[key: string]: QueryValue},
  originalQuery: Request['query'],
): {[key: string]: QueryValue} {
  const page = normalizePaginationValue('page', query.page ?? PAGINATION_DEFAULTS.page);
  const limit = normalizePaginationValue('limit', query.limit ?? PAGINATION_DEFAULTS.limit);
  const hasExplicitOffset = Object.prototype.hasOwnProperty.call(originalQuery, 'offset');
  const calculatedOffset =
    (page - PAGINATION_CONSTRAINTS.page.min) * limit;

  query.page = page;
  query.limit = limit;
  query.offset = hasExplicitOffset
    ? normalizePaginationValue('offset', query.offset ?? PAGINATION_DEFAULTS.offset)
    : normalizePaginationValue('offset', calculatedOffset);

  return query;
}

export function queryValidator(req: Request, res: Response, next: NextFunction): void {
  const sanitizedQuery: {[key: string]: QueryValue} = {};

  for (const [key, value] of Object.entries(req.query)) {
    const result = sanitizeQueryValue(key, value as QueryValue);

    if (result.error) {
      res.status(400).json({error: result.error});
      return;
    }

    sanitizedQuery[key] = result.value as QueryValue;
  }

  req.query = applyPaginationDefaults(sanitizedQuery, req.query) as Request['query'];
  next();
}

export default queryValidator;
