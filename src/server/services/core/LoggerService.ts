import winston from 'winston';
import 'winston-daily-rotate-file';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { getTraceLogFields } from '@/observability/traceContextForLogs.js';
dotenv.config();

/**
 * Mojibake / migration CLIs write machine-readable lines to stdout (NDJSON). Winston's default
 * Console transport writes to stdout too, so shell redirects (`> hits.ndjson`) capture noise.
 * Omit the console transport when stdout is piped/redirected for those entrypoints only.
 * Override: TUF_SUPPRESS_CONSOLE_LOGGER=1 (always omit) or =0 (always attach).
 */
function isMachineReadableStdoutScriptProcess(): boolean {
  return process.argv.some(
    (arg) =>
      arg.includes('auditLevelzipMojibakeMetadata') || arg.includes('migrateMojibakeLevelZipsFromHits')
  );
}

function shouldAttachWinstonConsoleTransport(): boolean {
  const flag = process.env.TUF_SUPPRESS_CONSOLE_LOGGER;
  if (flag === '1') return false;
  if (flag === '0') return true;
  if (process.stdout.isTTY === true) return true;
  if (!isMachineReadableStdoutScriptProcess()) return true;
  return false;
}

// Define log directory
const logDir = process.env.LOG_PATH || path.resolve('../logs');

// Ensure log directory exists
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Color configuration for console transport
const colors = {
  date: '\x1b[0;90m',
  info: '\x1b[0;32m',
  warn: '\x1b[0;33m',
  error: '\x1b[0;31m',
  debug: '\x1b[0;36m'
};

const reset = '\x1b[0m';

/**
 * Redact secrets and PII from log strings before egress.
 */
export function redactSensitiveText(input: string): string {
  let out = input;
  // Emails
  out = out.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    '[REDACTED_EMAIL]',
  );
  // MailerSend API tokens
  out = out.replace(/\bmlsn\.[A-Za-z0-9._-]+/gi, 'mlsn.[REDACTED]');
  // Bearer tokens
  out = out.replace(/\bBearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED]');
  // JWT-shaped
  out = out.replace(
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    '[REDACTED_JWT]',
  );
  // Query/body token or code params
  out = out.replace(
    /([?&](?:token|code)=)[^&\s"']+/gi,
    '$1[REDACTED]',
  );
  // Long hex blobs (opaque tokens / hashes)
  out = out.replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED_HEX]');
  return out;
}

function redactMetaValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[Truncated]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveText(value.message),
      stack: value.stack ? redactSensitiveText(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactMetaValue(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keyLower = k.toLowerCase();
      if (
        keyLower.includes('password') ||
        keyLower.includes('token') ||
        keyLower.includes('secret') ||
        keyLower.includes('authorization')
      ) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactMetaValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/**
 * Safely stringify objects with potential circular references
 */
const safeStringify = (obj: any): string => {
  if (!obj || Object.keys(obj).length === 0) return '';

  try {
    // Handle circular references by using a cache
    const cache: any[] = [];
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        // Check for circular reference
        if (cache.includes(value)) {
          return '[Circular Reference]';
        }
        cache.push(value);
      }
      return value;
    });
  } catch (error) {
    return `[Error serializing object: ${error instanceof Error ? error.message : String(error)}]`;
  }
};

/**
 * Extract and format metadata including Symbol properties (splat)
 */
const extractMetadata = (info: any): string => {
  const parts: string[] = [];

  // Extract splat array from Symbol property (Winston stores additional args here)
  // Check all Symbol properties to find the splat array
  const symbols = Object.getOwnPropertySymbols(info);
  let splat: any[] | undefined;
  let sawNonInternalObjectInSplat = false;

  for (const sym of symbols) {
    const value = info[sym];
    // Winston's splat is an array containing the additional arguments
    if (Array.isArray(value) && value.length > 0) {
      // Check if it looks like a splat array (contains non-Symbol, non-internal values)
      // Skip arrays that only contain Symbols or Winston internal values
      const hasNonSymbolValues = value.some((v: any) => {
        if (typeof v === 'symbol') return false;
        // Skip Winston internal objects that might be in the array
        if (typeof v === 'object' && v !== null) {
          // Check if it's a Winston log info object (has level/message)
          if (v.level && v.message) return false;
        }
        return true;
      });

      if (hasNonSymbolValues) {
        splat = value;
        break;
      }
    }
  }

  // Format splat values
  if (splat && splat.length > 0) {
    splat.forEach((item: any) => {
      // Skip Symbol values and Winston internal objects
      if (typeof item === 'symbol') {
        return;
      }

      // Skip Winston log info objects (they're internal)
      if (typeof item === 'object' && item !== null && item.level && item.message) {
        return;
      }

      if (item === null || item === undefined) {
        parts.push(String(item));
      } else if (typeof item === 'object') {
        sawNonInternalObjectInSplat = true;
        parts.push(safeStringify(item));
      } else {
        parts.push(String(item));
      }
    });
  }

  // Extract regular metadata (excluding known Winston properties and Symbol keys)
  // NOTE: When logging objects, Winston can expose them both via the splat Symbol
  // AND as merged enumerable keys on `info`. If we already printed object splat,
  // skip regularMeta to prevent duplicated meta objects in output.
  if (sawNonInternalObjectInSplat) {
    return parts.length > 0 ? parts.join(' ') : '';
  }

  const knownKeys = ['level', 'message', 'timestamp', 'splat'];
  const regularMeta: Record<string, any> = {};
  for (const key in info) {
    if (!knownKeys.includes(key) && typeof key !== 'symbol') {
      regularMeta[key] = info[key];
    }
  }

  if (Object.keys(regularMeta).length > 0) {
    parts.push(safeStringify(regularMeta));
  }

  return parts.length > 0 ? parts.join(' ') : '';
};

// Define log format
const logFormat = winston.format.printf((info) => {
  const { level, message, timestamp } = info;
  const meta = extractMetadata(info);
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${meta ? ' ' + meta : ''}`;
});

// Console format with colors
const consoleFormat = winston.format.printf((info) => {
  const { level, message, timestamp } = info;
  let coloredLevel;
  switch (level) {
    case 'info':
      coloredLevel = `${colors.info}[INFO]${reset}`;
      break;
    case 'warn':
      coloredLevel = `${colors.warn}[WARN]${reset}`;
      break;
    case 'error':
      coloredLevel = `${colors.error}[ERROR]${reset}`;
      break;
    case 'debug':
      coloredLevel = `${colors.debug}[DEBUG]${reset}`;
      break;
    default:
      coloredLevel = `[${level.toUpperCase()}]`;
  }

  const coloredTimestamp = `${colors.date}[${timestamp}]${reset}`;
  const meta = extractMetadata(info);
  return `${coloredTimestamp} ||| ${coloredLevel} ${message}${meta ? ' ' + meta : ''}`;
});

/**
 * Emitted after each log line is written so subscribers can react without touching every route.
 * `message` is the string passed to info/warn/error/debug; `meta` is the spread args after it.
 * Listeners decide how to interpret `message` / `meta` (the logger does not classify errors).
 */
export interface LogReplayEvent {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  meta: unknown[];
}

export type LogReplayListener = (event: LogReplayEvent) => void;

/**
 * Logger singleton service using Winston
 */
class LoggerService {
  private static instance: LoggerService;
  private logger: winston.Logger;
  private readonly logReplayListeners = new Set<LogReplayListener>();

  private constructor() {
    // Define transports
    const fileRotateTransport = new winston.transports.DailyRotateFile({
      filename: path.join(logDir, '%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '10d',
      format: winston.format.combine(
        winston.format.timestamp(),
        logFormat
      )
    });

    const transports: winston.transport[] = [fileRotateTransport];
    if (shouldAttachWinstonConsoleTransport()) {
      transports.push(
        new winston.transports.Console({
          format: winston.format.combine(winston.format.timestamp(), consoleFormat)
        })
      );
    }

    // Create logger instance
    this.logger = winston.createLogger({
      level: process.env.MODE !== 'debug' ? 'info' : 'debug',
      transports
    });

    this.info('Logger initialized');
  }

  /**
   * Subscribe to log replay events (same payload as written to transports).
   * Returns an unsubscribe function.
   */
  public addLogReplayListener(listener: LogReplayListener): () => void {
    this.logReplayListeners.add(listener);
    return () => {
      this.logReplayListeners.delete(listener);
    };
  }

  private emitLogReplay(event: LogReplayEvent): void {
    for (const listener of this.logReplayListeners) {
      try {
        listener(event);
      } catch (e) {
        // Avoid routing back through winston (recursion / listener failure loops)
        console.error('[LoggerService] log replay listener threw:', e);
      }
    }
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): LoggerService {
    if (!LoggerService.instance) {
      LoggerService.instance = new LoggerService();
    }

    return LoggerService.instance;
  }

  /**
   * Log info message
   */
  public info(message: string, ...meta: any[]): void {
    const safeMessage = redactSensitiveText(String(message));
    const safeMeta = meta.map((m) => redactMetaValue(m));
    this.logger.info(safeMessage, ...safeMeta);
    this.emitLogReplay({ level: 'info', message: safeMessage, meta: safeMeta });
  }

  public warn(message: string, ...meta: any[]): void {
    const safeMessage = redactSensitiveText(String(message));
    const safeMeta = this.withTraceFields(meta.map((m) => redactMetaValue(m)));
    this.logger.warn(safeMessage, ...safeMeta);
    this.emitLogReplay({ level: 'warn', message: safeMessage, meta: safeMeta });
  }

  public error(message: string, ...meta: any[]): void {
    const safeMessage = redactSensitiveText(String(message));
    const safeMeta = this.withTraceFields(meta.map((m) => redactMetaValue(m)));
    this.logger.error(safeMessage, ...safeMeta);
    this.emitLogReplay({ level: 'error', message: safeMessage, meta: safeMeta });
  }

  /**
   * Attach active Sentry trace/span ids to warn/error metadata when present.
   */
  private withTraceFields(safeMeta: unknown[]): unknown[] {
    try {
      const fields = getTraceLogFields();
      if (!fields.trace_id && !fields.span_id) {
        return safeMeta;
      }
      return [...safeMeta, fields];
    } catch {
      return safeMeta;
    }
  }

  public debug(message: string, ...meta: any[]): void {
    const safeMessage = redactSensitiveText(String(message));
    const safeMeta = meta.map((m) => redactMetaValue(m));
    this.logger.debug(safeMessage, ...safeMeta);
    this.emitLogReplay({ level: 'debug', message: safeMessage, meta: safeMeta });
  }
}

// Create a logger instance for export
const logger = LoggerService.getInstance();

// Log current mode
logger.info('current mode', process.env.MODE);

// Export the logger singleton
export { logger };
