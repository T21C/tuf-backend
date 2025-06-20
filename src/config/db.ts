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
    max: 50,
    min: 5,
    acquire: 30000,
    idle: 10000,
  },
  dialectOptions: {
    connectTimeout: 30000,
    acquireTimeout: 30000,
    timeout: 30000,
  },
  retry: {
    max: 3,
    backoffBase: 1000,
    backoffExponent: 1.5,
  },
});

export default sequelize;
