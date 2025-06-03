import { Model, DataTypes } from 'sequelize';
import sequelize from '../../config/db.js';
import CdnFile from './CdnFile.js';

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
        references: {
            model: CdnFile,
            key: 'id'
        }
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
    sequelize,
    modelName: 'FileAccessLog',
    tableName: 'file_access_logs',
    timestamps: true
});

// Define associations
CdnFile.hasMany(FileAccessLog, { foreignKey: 'fileId' });
FileAccessLog.belongsTo(CdnFile, { foreignKey: 'fileId' });

export default FileAccessLog; 