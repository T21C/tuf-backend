import {Sequelize} from 'sequelize';
import dotenv from 'dotenv';

dotenv.config();

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
    max: 20,
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
    
    console.log('All existing connections killed');
  } catch (error) {
    console.error('Error killing connections:', error);
  }
};

export const refreshConnectionPool = async (): Promise<void> => {
  try {
    await sequelize.connectionManager.close();
    
    await sequelize.connectionManager.initPools();
    
    console.log('Connection pool refreshed');
  } catch (error) {
    console.error('Error refreshing connection pool:', error);
  }
};

export const getConnectionStats = async (): Promise<any> => {
  try {
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
    console.error('Error getting connection stats:', error);
    return null;
  }
};

export const gracefulShutdown = async (): Promise<void> => {
  try {
    console.log('Closing database connections...');
    await sequelize.close();
    console.log('Database connections closed');
  } catch (error) {
    console.error('Error during graceful shutdown:', error);
  }
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

export default sequelize;
