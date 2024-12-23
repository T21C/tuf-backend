import {Sequelize} from 'sequelize';
import db from '../models/index';
import reloadDatabase from './reloadDatabase';
import { raterList, SUPER_ADMINS } from '../config/constants';
import { Rater } from '../services/RaterService';
import sequelize from '../config/db';

async function populateRaters(transaction: any) {
  try {
    console.log('Starting rater population...');

    // Remove all super admins from raterList
    const regularRaters = raterList.filter(name => !SUPER_ADMINS.includes(name));
    console.log(`Processing ${regularRaters.length} regular raters and ${SUPER_ADMINS.length} super admins`);

    // Create regular raters
    const createdRaters = [];
    for (const name of regularRaters) {
      try {
        const rater = await Rater.create({
          name,
          discordId: name,
          isSuperAdmin: false
        }, { 
          transaction
        });
        createdRaters.push(rater);
        console.log(`Created regular rater: ${name}`);
      } catch (error) {
        console.error(`Failed to create regular rater ${name}:`, error);
        throw error;
      }
    }

    // Create super admins
    for (const name of SUPER_ADMINS) {
      try {
        const rater = await Rater.create({
          name,
          discordId: name,
          isSuperAdmin: true // Explicitly set for super admins
        }, { 
          transaction
        });
        createdRaters.push(rater);
        console.log(`Created super admin: ${name}`);
      } catch (error) {
        console.error(`Failed to create super admin ${name}:`, error);
        throw error;
      }
    }

    const expectedTotal = regularRaters.length + SUPER_ADMINS.length;
    console.log(`${createdRaters.length} total raters created`);

    // Verify all raters were created
    const totalRaters = await Rater.count({ transaction });
    console.log(`Total raters in database: ${totalRaters}`);
    console.log(`Expected total raters: ${expectedTotal}`);

    if (totalRaters !== expectedTotal) {
      // Get all raters to check what's actually in the database
      const dbRaters = await Rater.findAll({ transaction });
      const existingNames = dbRaters.map(r => r.name);
      const allExpectedNames = [...regularRaters, ...SUPER_ADMINS];
      const missingNames = allExpectedNames.filter(name => !existingNames.includes(name));
      
      throw new Error(
        `Rater count mismatch: expected ${expectedTotal}, got ${totalRaters}\n` +
        `Missing raters: ${missingNames.join(', ')}`
      );
    }

    // Verify super admin status
    const dbRaters = await Rater.findAll({ transaction });
    for (const rater of dbRaters) {
      const shouldBeSuperAdmin = SUPER_ADMINS.includes(rater.name);
      if (rater.isSuperAdmin !== undefined && shouldBeSuperAdmin !== rater.isSuperAdmin) {
        throw new Error(
          `Super admin status mismatch for ${rater.name}: ` +
          `expected ${shouldBeSuperAdmin}, got ${rater.isSuperAdmin}`
        );
      }
    }

    console.log('Rater population completed successfully');
    return createdRaters;
  } catch (error) {
    console.error('Error populating raters:', error);
    throw error;
  }
}

async function initializeDatabase() {
  const transaction = await sequelize.transaction();

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

    // Populate raters
    await populateRaters(transaction);

    await transaction.commit();
    console.log('Database initialized successfully');
  } catch (error) {
    await transaction.rollback();
    console.error('Error initializing database:', error);
    throw error;
  }
}

export default initializeDatabase;
