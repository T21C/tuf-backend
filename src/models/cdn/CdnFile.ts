import { Model, DataTypes } from 'sequelize';
import sequelize from '../../config/db.js';

class CdnFile extends Model {
    declare id: string;
    declare purpose: 'PROFILE' | 'BANNER' | 'THUMBNAIL' | 'ASSET' | 'DOTADOFAI' | 'GENERAL';
    declare originalName: string;
    declare filePath: string;
    declare fileType: string;
    declare fileSize: number;
    declare mimeType: string;
    declare accessCount: number;
    declare isPublic: boolean;
    declare parentId: string | null;
    declare isDirectory: boolean;
    declare relativePath: string | null;
    declare zipFileId: string | null;
}

CdnFile.init({
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    purpose: {
        type: DataTypes.ENUM('PROFILE', 'BANNER', 'THUMBNAIL', 'ASSET', 'DOTADOFAI', 'GENERAL'),
        allowNull: false,
        defaultValue: 'GENERAL'
    },
    originalName: {
        type: DataTypes.STRING,
        allowNull: true
    },
    filePath: {
        type: DataTypes.STRING,
        allowNull: false
    },
    fileType: {
        type: DataTypes.STRING,
        allowNull: true
    },
    fileSize: {
        type: DataTypes.BIGINT,
        allowNull: false
    },
    mimeType: {
        type: DataTypes.STRING,
        allowNull: true
    },
    accessCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
    },
    isPublic: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
    },
    metadata: {
        type: DataTypes.JSON,
        allowNull: true
    },
    parentId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
            model: 'cdn_files',
            key: 'id'
        }
    },
    isDirectory: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
    },
    relativePath: {
        type: DataTypes.STRING,
        allowNull: true
    },
    zipFileId: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
            model: 'cdn_files',
            key: 'id'
        }
    }
}, {
    sequelize,
    modelName: 'CdnFile',
    tableName: 'cdn_files',
    timestamps: true
});

export default CdnFile; 