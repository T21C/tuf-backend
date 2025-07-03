#!/usr/bin/env node

import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';
dotenv.config();

// Create a direct connection for management
const sequelize = new Sequelize({
  dialect: 'mysql',
  host: process.env.DB_HOST,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.NODE_ENV === 'staging' 
    ? process.env.DB_STAGING_DATABASE 
    : process.env.DB_DATABASE,
  logging: false,
});

async function killAllConnections() {
  try {
    const database = process.env.NODE_ENV === 'staging' 
      ? process.env.DB_STAGING_DATABASE 
      : process.env.DB_DATABASE;
    
    const [results] = await sequelize.query(`
      SELECT CONCAT('KILL ', id, ';') as kill_command
      FROM information_schema.processlist 
      WHERE db = ? 
      AND id != CONNECTION_ID()
    `, {
      replacements: [database]
    });
    
    if (results.length > 0) {
      console.log(`Found ${results.length} connections to kill`);
      for (const row of results as any) {
        try {
          await sequelize.query(row.kill_command);
        } catch (error: any) {
          // Connection might already be dead
          console.log(`Connection already closed or error: ${error.message}`);
        }
      }
      console.log('All existing connections killed');
    } else {
      console.log('No connections to kill');
    }
  } catch (error: any) {
    console.error('Error killing connections:', error.message);
  }
}

async function getConnectionStats() {
  try {
    const database = process.env.NODE_ENV === 'staging' 
      ? process.env.DB_STAGING_DATABASE 
      : process.env.DB_DATABASE;
    
    const [results] = await sequelize.query(`
      SELECT 
        COUNT(*) as total_connections,
        COUNT(CASE WHEN Command = 'Sleep' THEN 1 END) as idle_connections,
        COUNT(CASE WHEN Command != 'Sleep' THEN 1 END) as active_connections,
        GROUP_CONCAT(CONCAT('ID:', id, ' User:', user, ' Host:', host, ' Command:', Command) SEPARATOR ' | ') as connection_details
      FROM information_schema.processlist 
      WHERE db = ?
    `, {
      replacements: [database]
    });
    
    console.log('Connection Statistics:');
    console.log(JSON.stringify(results[0], null, 2));
    
    return results[0];
  } catch (error: any) {
    console.error('Error getting connection stats:', error.message);
    return null;
  }
}

async function showAllConnections() {
  try {
    const database = process.env.NODE_ENV === 'staging' 
      ? process.env.DB_STAGING_DATABASE 
      : process.env.DB_DATABASE;
    
    const [results] = await sequelize.query(`
      SELECT 
        id,
        user,
        host,
        db,
        command,
        time,
        state,
        info
      FROM information_schema.processlist 
      WHERE db = ?
      ORDER BY time DESC
    `, {
      replacements: [database]
    });
    
    console.log(`\nAll connections to database '${database}':`);
    console.table(results);
    
    return results;
  } catch (error: any) {
    console.error('Error getting all connections:', error.message);
    return null;
  }
}

async function main() {
  const command = process.argv[2];
  
  try {
    await sequelize.authenticate();
    console.log('Database connection established successfully');
    
    switch (command) {
      case 'kill':
        await killAllConnections();
        break;
      case 'stats':
        await getConnectionStats();
        break;
      case 'list':
        await showAllConnections();
        break;
      case 'reset':
        console.log('Performing complete reset...');
        await killAllConnections();
        console.log('Waiting 2 seconds...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        await getConnectionStats();
        break;
      default:
        console.log(`
Database Connection Manager

Usage: node manageConnections.js [command]

Commands:
  kill   - Kill all existing connections except current
  stats  - Show connection statistics
  list   - List all current connections
  reset  - Kill connections and show stats

Examples:
  node manageConnections.js stats
  node manageConnections.js kill
  node manageConnections.js reset
        `);
    }
  } catch (error: any) {
    console.error('Database connection failed:', error.message);
  } finally {
    await sequelize.close();
  }
}

main();