import type {Response} from 'express';
import {logger} from '@/server/services/core/LoggerService.js';

export type MysqlClientErrorPayload = {
  status: number;
  error: string;
  code: string;
};

/** MySQL errnos that reflect bad client/input data rather than server failures. */
const MYSQL_CLIENT_ERRNO: Record<
  number,
  {status: number; code: string; fallback: string}
> = {
  1062: {status: 409, code: 'ER_DUP_ENTRY', fallback: 'Duplicate entry'},
  1048: {status: 400, code: 'ER_BAD_NULL_ERROR', fallback: 'Required field is missing'},
  1364: {status: 400, code: 'ER_NO_DEFAULT_FOR_FIELD', fallback: 'Required field has no default'},
  1406: {status: 400, code: 'ER_DATA_TOO_LONG', fallback: 'Value exceeds maximum length'},
  1264: {status: 400, code: 'ER_WARN_DATA_OUT_OF_RANGE', fallback: 'Value out of range'},
  1265: {status: 400, code: 'ER_WARN_DATA_TRUNCATED', fallback: 'Value was truncated'},
  1292: {status: 400, code: 'ER_TRUNCATED_WRONG_VALUE', fallback: 'Invalid value for field'},
  1366: {
    status: 400,
    code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
    fallback: 'Invalid value for field',
  },
  3819: {status: 400, code: 'ER_CHECK_CONSTRAINT_VIOLATED', fallback: 'Check constraint failed'},
  4025: {status: 400, code: 'ER_CONSTRAINT_FAILED', fallback: 'Constraint failed'},
  1452: {
    status: 400,
    code: 'ER_NO_REFERENCED_ROW_2',
    fallback: 'Invalid related record reference',
  },
  1451: {
    status: 409,
    code: 'ER_ROW_IS_REFERENCED_2',
    fallback: 'Record is still referenced',
  },
};

function getMysqlErrno(error: any): number | null {
  const errno = error?.parent?.errno ?? error?.original?.errno ?? error?.errno;
  return typeof errno === 'number' ? errno : null;
}

function getSqlMessage(error: any): string | null {
  const msg = error?.parent?.sqlMessage ?? error?.original?.sqlMessage ?? null;
  return typeof msg === 'string' && msg.trim() ? msg : null;
}

export function mapMysqlClientError(
  error: unknown,
  opts?: {uniqueMessage?: string},
): MysqlClientErrorPayload | null {
  const err = error as any;
  if (!err || typeof err !== 'object') return null;

  if (err.name === 'SequelizeUniqueConstraintError') {
    return {
      status: 409,
      error: opts?.uniqueMessage || getSqlMessage(err) || 'Duplicate entry',
      code: 'ER_DUP_ENTRY',
    };
  }

  if (err.name === 'SequelizeValidationError') {
    const first = Array.isArray(err.errors)
      ? err.errors.find((e: any) => e?.message)?.message
      : null;
    return {
      status: 400,
      error: first || err.message || 'Validation failed',
      code: 'VALIDATION_ERROR',
    };
  }

  if (err.name === 'SequelizeForeignKeyConstraintError') {
    return {
      status: 400,
      error: getSqlMessage(err) || 'Invalid related record reference',
      code: 'ER_NO_REFERENCED_ROW',
    };
  }

  const errno = getMysqlErrno(err);
  if (errno != null && MYSQL_CLIENT_ERRNO[errno]) {
    const meta = MYSQL_CLIENT_ERRNO[errno];
    const message =
      errno === 1062 && opts?.uniqueMessage
        ? opts.uniqueMessage
        : getSqlMessage(err) || meta.fallback;
    return {status: meta.status, error: message, code: meta.code};
  }

  // Some call paths only expose MySQL's string code (no errno / Sequelize name).
  const mysqlCode = err?.parent?.code ?? err?.original?.code ?? err?.code;
  if (mysqlCode === 'ER_DUP_ENTRY') {
    return {
      status: 409,
      error: opts?.uniqueMessage || getSqlMessage(err) || 'Duplicate entry',
      code: 'ER_DUP_ENTRY',
    };
  }

  return null;
}

/** Returns true when the error was mapped to a 4xx client response (no 500 log). */
export function tryRespondMysqlClientError(
  res: Response,
  error: unknown,
  opts?: {uniqueMessage?: string},
): boolean {
  const mapped = mapMysqlClientError(error, opts);
  if (!mapped) return false;
  res.status(mapped.status).json({error: mapped.error, code: mapped.code});
  return true;
}

/** Map known MySQL/Sequelize client errors to 4xx; otherwise log and return 500. */
export function respondMysqlClientError(
  res: Response,
  error: unknown,
  fallbackMessage: string,
  opts?: {uniqueMessage?: string; logLabel?: string},
): Response {
  if (tryRespondMysqlClientError(res, error, opts)) {
    return res;
  }
  logger.error(opts?.logLabel || fallbackMessage, error);
  return res.status(500).json({error: fallbackMessage});
}
