import db from '../models/index';

async function initializeDatabase() {
  try {
    console.log('Starting database initialization...');
    await db.sequelize.authenticate();
    console.log('Database connection authenticated.');
    await db.sequelize.sync({ force: true });
    console.log('All tables created successfully!');
    return true;
  } catch (error) {
    console.error('Database initialization failed:', error);
    throw error;
  }
}

export default initializeDatabase;