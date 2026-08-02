require('dotenv').config();

// sequelize-cli selects a block by NODE_ENV or --env, but every environment targets the
// same DB_* host database. Kept as one object so it cannot drift from PoolManager's
// baseConfig, which the running application uses.
const connection = {
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
  dialect: 'mysql',
  logging: false
};

module.exports = {
  development: {...connection},
  test: {...connection},
  production: {...connection}
};
