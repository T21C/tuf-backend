import { logger } from '@/server/services/core/LoggerService.js';

const isClientDisconnectError = (error: any): boolean => {
  return error?.code === 'ECONNRESET' || error?.code === 'EPIPE';
};

const isDatabaseConnectionError = (reason: any): boolean => {
  return Boolean(
    reason &&
      (
        reason.code === 'ECONNREFUSED' ||
        reason.code === 'PROTOCOL_CONNECTION_LOST' ||
        reason.code === 'ETIMEDOUT' ||
        reason.name === 'SequelizeConnectionRefusedError' ||
        reason.name === 'SequelizeConnectionError' ||
        reason.name === 'SequelizeConnectionAcquireTimeoutError'
      ),
  );
};

interface RegisterProcessHandlersOptions {
  onShutdown: () => Promise<void>;
}

/**
 * Registers global process-level handlers (exceptions, rejections, signals).
 * Keep this separate from Express wiring so app bootstrap stays focused.
 */
export function registerGlobalProcessHandlers(options: RegisterProcessHandlersOptions): void {
  process.on('uncaughtException', (error: any) => {
    if (isClientDisconnectError(error)) {
      logger.warn('Client disconnected during operation:', {
        code: error.code,
        message: error.message,
        syscall: error.syscall,
      });
      return;
    }

    logger.error('UNCAUGHT EXCEPTION:', {
      message: error.message,
      code: error.code,
      syscall: error.syscall,
      stack: error.stack,
    });
  });

  process.on('unhandledRejection', (reason: any, promise) => {
    if (isClientDisconnectError(reason)) {
      logger.warn('Client disconnected (unhandled rejection):', {
        code: reason.code,
        message: reason.message,
        syscall: reason.syscall,
      });
      return;
    }

    if (isDatabaseConnectionError(reason)) {
      logger.warn('Database connection error (unhandled rejection):', {
        code: reason.code || reason.name,
        message: reason.message,
        note: 'Sequelize will attempt to reconnect automatically on next query',
      });
      return;
    }

    if (reason instanceof Error && reason.message.includes('Transaction cannot be rolled back')) {
      logger.warn('Transaction rollback error detected - this is likely a duplicate rollback call');
      return;
    }

    logger.error('UNHANDLED REJECTION! Logging error but continuing...');
    logger.error('Reason:', reason);
    logger.error('Promise:', promise);
    logger.error('Stack trace:', reason instanceof Error ? reason.stack : 'No stack trace available');
  });

  process.on('warning', (warning) => {
    if (warning.name === 'TimeoutNegativeWarning') {
      logger.debug('Cron job scheduling adjustment (overlapping executions)');
      return;
    }
    logger.warn('Node.js Warning:', warning);
  });

  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received. Shutting down gracefully...');
    await options.onShutdown();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT received. Shutting down gracefully...');
    await options.onShutdown();
    process.exit(0);
  });
}
