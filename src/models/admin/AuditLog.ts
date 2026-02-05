import { DataTypes, Sequelize } from 'sequelize';
import BaseModel from '../BaseModel.js';
import dotenv from 'dotenv';

dotenv.config();

// Create explicit Sequelize instance for logging database
const loggingSequelize = new Sequelize({
    dialect: 'mysql',
    host: process.env.DB_HOST,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_LOGGING_DATABASE || 'tuf_logging',
    dialectOptions: {
        connectTimeout: 60000,
        timezone: '+00:00',
    },
    pool: {
        max: 5,
        min: 1,
        acquire: 20000,
        idle: 10000,
    },
    logging: false, // Disable query logging for logging models
});

class AuditLog extends BaseModel {
  declare userId: string | null;
  declare action: string;
  declare route: string;
  declare method: string;
  declare payload: any;
  declare result: any;
}

AuditLog.init(
  {
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      // Note: Foreign key removed since User is in main database
      // We store the userId as UUID but don't enforce referential integrity
    },
    action: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    route: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    method: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    result: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },
  {
    sequelize: loggingSequelize,
    modelName: 'AuditLog',
    tableName: 'audit_logs',
    timestamps: true,
  },
);

// Note: Association removed since AuditLog is now in a separate database
// AuditLog.belongsTo(User, { as: 'user', foreignKey: 'userId' });

export default AuditLog;
