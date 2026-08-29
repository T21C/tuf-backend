import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('admin');

class Mod extends Model<InferAttributes<Mod>, InferCreationAttributes<Mod>> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare creatorUsername: string;
  declare creatorDiscordId: string;
  declare version: CreationOptional<string | null>;
  declare description: CreationOptional<string | null>;
  declare downloadUrl: string;
  declare imageUrl: CreationOptional<string | null>;
  declare sourceUploadedAt: Date;
  declare hidden: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

Mod.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(512),
      allowNull: false,
    },
    creatorUsername: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    creatorDiscordId: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    version: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    downloadUrl: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    imageUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    sourceUploadedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    hidden: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
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
    tableName: 'mods',
    indexes: [{fields: ['hidden'], name: 'idx_mods_hidden'}],
  },
);

export default Mod;
