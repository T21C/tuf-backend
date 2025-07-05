import {Sequelize} from 'sequelize';
import dotenv from 'dotenv';
import { logger } from '../services/LoggerService.js';

dotenv.config();

const MAX_CONNECTIONS = 20;
const sequelize = new Sequelize({
  dialect: 'mysql',
  host: process.env.DB_HOST,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database:
    process.env.NODE_ENV === 'staging'
      ? process.env.DB_STAGING_DATABASE
      : process.env.DB_DATABASE,
  logging: false,
  pool: {
    max: MAX_CONNECTIONS,
    min: 2,
    acquire: 60000,
    idle: 10000,
    validate: (connection: any) => {
      return connection.query('SELECT 1');
    },
    evict: 30000,
  },
  dialectOptions: {
    connectTimeout: 60000,
  },
  retry: {
    max: 3,
    backoffBase: 1000,
    backoffExponent: 1.5,
  },
});

// Connection monitoring configuration
const CONNECTION_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
const CONNECTION_THRESHOLD = 0.8; // 80% of max connections
const IDLE_CONNECTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes - close connections idle for this long

let connectionMonitorTimer: NodeJS.Timeout | null = null;
let isRefreshingPool = false;

export const closeIdleConnections = async (): Promise<void> => {
  try {
    if (!isConnectionManagerAvailable()) {
      logger.warn('Connection manager not available for idle connection cleanup');
      return;
    }

    const [results] = await sequelize.query(`
      SELECT id, time 
      FROM information_schema.processlist 
      WHERE db = ? 
      AND Command = 'Sleep' 
      AND time > ?
      AND id != CONNECTION_ID()
    `, {
      replacements: [
        process.env.NODE_ENV === 'staging'
          ? process.env.DB_STAGING_DATABASE
          : process.env.DB_DATABASE,
        Math.floor(IDLE_CONNECTION_TIMEOUT / 1000) // Convert to seconds
      ]
    });

    if (results && results.length > 0) {
      logger.info(`Found ${results.length} idle connections to close`);
      
      for (const connection of results as any[]) {
        try {
          await sequelize.query(`KILL ${connection.id}`);
          logger.debug(`Closed idle connection ${connection.id} (idle for ${connection.time}s)`);
        } catch (error) {
          logger.warn(`Failed to close connection ${connection.id}:`, error);
        }
      }
      
      logger.info(`Successfully closed ${results.length} idle connections`);
    } else {
      logger.debug('No idle connections found to close');
    }
  } catch (error) {
    logger.error('Error closing idle connections:', error);
  }
};

export const startConnectionMonitoring = (): void => {
  if (connectionMonitorTimer) {
    logger.warn('Connection monitoring already started');
    return;
  }

  connectionMonitorTimer = setInterval(async () => {
    try {
      // Don't refresh if already refreshing
      if (isRefreshingPool) {
        logger.debug('Skipping connection monitoring - pool refresh in progress');
        return;
      }

      const stats = await getConnectionStats();
      
      if (stats) {
        const totalConnections = stats.total_connections;
        const activeConnections = stats.active_connections;
        const idleConnections = stats.idle_connections;
        const connectionUsage = totalConnections / MAX_CONNECTIONS;
        
        logger.info(`Connection stats - Total: ${totalConnections}, Active: ${activeConnections}, Idle: ${idleConnections}, Usage: ${(connectionUsage * 100).toFixed(1)}%`);
        
        // Close idle connections first
        if (connectionUsage > CONNECTION_THRESHOLD) {
          logger.info(`Closing ${idleConnections} idle connections due to usage above threshold...`);
          await closeIdleConnections();
        }
      }
    } catch (error) {
      logger.error('Error in connection monitoring:', error);
    }
  }, CONNECTION_CHECK_INTERVAL);

  logger.info('Database connection monitoring started');
};

export const stopConnectionMonitoring = (): void => {
  if (connectionMonitorTimer) {
    clearInterval(connectionMonitorTimer);
    connectionMonitorTimer = null;
    logger.info('Database connection monitoring stopped');
  }
};

export const killAllConnections = async (): Promise<void> => {
  try {
    await sequelize.query(`
      SELECT CONCAT('KILL ', id, ';') 
      FROM information_schema.processlist 
      WHERE db = ? 
      AND id != CONNECTION_ID()
    `, {
      replacements: [
        process.env.NODE_ENV === 'staging'
          ? process.env.DB_STAGING_DATABASE
          : process.env.DB_DATABASE
      ]
    });
    
    logger.info('All existing connections killed');
  } catch (error) {
    logger.error('Error killing connections:', error);
  }
};

export const isConnectionManagerAvailable = (): boolean => {
  return sequelize.connectionManager && !isRefreshingPool;
};

export const getConnectionStats = async (): Promise<any> => {
  try {
    // Check if connection manager is available
    if (!isConnectionManagerAvailable()) {
      logger.warn('Connection manager not available for stats check');
      return null;
    }

    const [results] = await sequelize.query(`
      SELECT 
        COUNT(*) as total_connections,
        COUNT(CASE WHEN Command = 'Sleep' THEN 1 END) as idle_connections,
        COUNT(CASE WHEN Command != 'Sleep' THEN 1 END) as active_connections
      FROM information_schema.processlist 
      WHERE db = ?
    `, {
      replacements: [
        process.env.NODE_ENV === 'staging'
          ? process.env.DB_STAGING_DATABASE
          : process.env.DB_DATABASE
      ]
    });
    
    return results[0];
  } catch (error) {
    logger.error('Error getting connection stats:', error);
    return null;
  }
};

export const gracefulShutdown = async (): Promise<void> => {
  try {
    logger.info('Stopping connection monitoring...');
    stopConnectionMonitoring();
    
    logger.info('Closing database connections...');
    await sequelize.close();
    logger.info('Database connections closed');
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
  }
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

export default sequelize;
