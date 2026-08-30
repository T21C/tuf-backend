import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  ForeignKey,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type Mod from './Mod.js';

const sequelize = getSequelizeForModelGroup('admin');

class ModVersion extends Model<InferAttributes<ModVersion>, InferCreationAttributes<ModVersion>> {
  declare id: CreationOptional<number>;
  declare modId: ForeignKey<Mod['id']>;
  declare version: string;
  declare downloadUrl: string;
  declare notes: CreationOptional<string | null>;
  declare releasedAt: Date;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare mod?: Mod;
}

ModVersion.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    modId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    version: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    downloadUrl: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    releasedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'mod_versions',
    indexes: [
      {unique: true, fields: ['modId', 'version'], name: 'mod_versions_mod_version_unique'},
      {fields: ['modId', 'releasedAt'], name: 'idx_mod_versions_mod_released'},
    ],
  },
);

export default ModVersion;
