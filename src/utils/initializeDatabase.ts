import {Sequelize} from 'sequelize';
import db from '../models/index';
import reloadDatabase from './reloadDatabase';

async function initializeDatabase() {
  try {
    console.log('Starting database initialization...');

    // Verify database connection
    await db.sequelize.authenticate();
    console.log('Database connection authenticated.');

    // Force sync all models
    // This will drop all tables and recreate them
    await db.sequelize.sync({force: true});
    console.log('Database schema created successfully.');

    // Reload data from BE API
    await reloadDatabase();
    console.log('Database data loaded successfully.');

    return true;
  } catch (error) {
    console.error('Database initialization failed:', error);
    throw error;
  }
}

export default initializeDatabase;
