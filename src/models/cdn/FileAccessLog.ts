import { Model, DataTypes } from 'sequelize';
import CdnFile from './CdnFile.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('logging');

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

// Note: Associations removed since FileAccessLog is now in a separate database
// CdnFile.hasMany(FileAccessLog, { foreignKey: 'fileId' });
// FileAccessLog.belongsTo(CdnFile, { foreignKey: 'fileId' });

export default FileAccessLog;
