import { Model, DataTypes } from 'sequelize';
import sequelize from '../../config/db.js';

class CdnFile extends Model {
    declare id: string;
    declare type: 'PROFILE' | 'BANNER' | 'THUMBNAIL' | 'LEVELZIP' | 'GENERAL';
    declare filePath: string;
    declare metadata: object;
    declare accessCount: number;
}

CdnFile.init({
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    type: {
        type: DataTypes.ENUM('PROFILE', 'BANNER', 'THUMBNAIL', 'LEVELZIP', 'GENERAL'),
        allowNull: false,
        defaultValue: 'GENERAL'
    },
    filePath: {
        type: DataTypes.STRING,
        allowNull: false
    },
    accessCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    metadata: {
        type: DataTypes.JSON,
        allowNull: true
    }
}, {
    sequelize,
    modelName: 'CdnFile',
    tableName: 'cdn_files',
    timestamps: true
});

export default CdnFile; 