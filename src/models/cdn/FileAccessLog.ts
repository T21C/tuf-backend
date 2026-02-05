import { Model, DataTypes, Sequelize } from 'sequelize';
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

class FileAccessLog extends Model {
    declare id: number;
    declare fileId: string;
    declare ipAddress: string;
    declare userAgent: string;
}

FileAccessLog.init({
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    fileId: {
        type: DataTypes.UUID,
        allowNull: false,
    },
    ipAddress: {
        type: DataTypes.STRING,
        allowNull: false
    },
    userAgent: {
        type: DataTypes.STRING,
        allowNull: true
    }
}, {
    sequelize: loggingSequelize,
    modelName: 'FileAccessLog',
    tableName: 'file_access_logs',
    timestamps: true
});

// Note: Associations removed since FileAccessLog is now in a separate database
// CdnFile.hasMany(FileAccessLog, { foreignKey: 'fileId' });
// FileAccessLog.belongsTo(CdnFile, { foreignKey: 'fileId' });

export default FileAccessLog;
