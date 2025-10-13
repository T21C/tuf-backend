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

// Define log format
const logFormat = winston.format.printf(({ level, message, timestamp, ...metadata }) => {
  const meta = Object.keys(metadata).length ? safeStringify(metadata) : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message} ${meta}`;
});

// Console format with colors
const consoleFormat = winston.format.printf(({ level, message, timestamp, ...metadata }) => {
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
  const meta = Object.keys(metadata).length ? safeStringify(metadata) : '';
  return `${coloredTimestamp} ||| ${coloredLevel} ${message} ${meta}`;
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
