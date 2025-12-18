import winston from 'winston';
import 'winston-daily-rotate-file';
import fs from 'fs';
import path from 'path';

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
        parts.push(safeStringify(item));
      } else {
        parts.push(String(item));
      }
    });
  }
  
  // Extract regular metadata (excluding known Winston properties and Symbol keys)
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
 * Logger singleton service using Winston
 */
class LoggerService {
  private static instance: LoggerService;
  private logger: winston.Logger;

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

    const consoleTransport = new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        consoleFormat
      )
    });

    // Create logger instance
    this.logger = winston.createLogger({
      level: process.env.NODE_ENV === 'production' && process.env.MODE !== 'debug' ? 'info' : 'debug',
      transports: [
        fileRotateTransport,
        consoleTransport
      ]
    });

    this.info('Logger initialized');
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
    this.logger.info(message, ...meta);
  }

  /**
   * Log warning message
   */
  public warn(message: string, ...meta: any[]): void {
    this.logger.warn(message, ...meta);
  }

  /**
   * Log error message
   */
  public error(message: string, ...meta: any[]): void {
    this.logger.error(message, ...meta);
  }

  /**
   * Log debug message
   */
  public debug(message: string, ...meta: any[]): void {
    this.logger.debug(message, ...meta);
  }
}

// Create a logger instance for export
const logger = LoggerService.getInstance();

// Log current mode
logger.info('current mode', process.env.MODE);

// Export the logger singleton
export { logger };
