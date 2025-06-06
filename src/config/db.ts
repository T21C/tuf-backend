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
    max: 25,
    min: 0,
    acquire: 60000,
    idle: 20000,
  },
  dialectOptions: {
    connectTimeout: 60000,
  },
  retry: {
    max: 3,
  },
});

export default sequelize;
