import { Model, DataTypes } from 'sequelize';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('cdn');

class CdnFile extends Model {
    declare id: string;
    declare type: 'PROFILE'
    | 'ICON'
    | 'BANNER'
    | 'THUMBNAIL'
    | 'CURATION_ICON'
    | 'LEVEL_THUMBNAIL'
    | 'PACK_ICON'
    | 'TAG_ICON'
    | 'LEVELZIP'
    | 'GENERAL'
    | 'EVIDENCE';
    declare filePath: string;
    declare metadata: object;
    declare accessCount: number;
    declare cacheData: string | null;
}

export type ImageFileType =
'PROFILE'
| 'ICON'
| 'BANNER'
| 'THUMBNAIL'
| 'CURATION_ICON'
| 'LEVEL_THUMBNAIL'
| 'PACK_ICON'
| 'TAG_ICON'
| 'EVIDENCE';

CdnFile.init({
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    type: {
        type: DataTypes.ENUM('PROFILE', 'ICON', 'BANNER', 'THUMBNAIL', 'CURATION_ICON', 'LEVEL_THUMBNAIL', 'PACK_ICON', 'TAG_ICON', 'LEVELZIP', 'GENERAL', 'EVIDENCE'),
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
    },
    cacheData: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: null
    }
}, {
    sequelize,
    modelName: 'CdnFile',
    tableName: 'cdn_files',
    timestamps: true,
    hooks: {
        beforeCreate: (instance: CdnFile) => {
            if (instance.filePath) {
                instance.filePath = instance.filePath.replace(/\\/g, '/');
            }
        },
        beforeUpdate: (instance: CdnFile) => {
            if (instance.changed('filePath')) {
                instance.filePath = instance.filePath.replace(/\\/g, '/');
            }
        }
    }
});

export default CdnFile;
