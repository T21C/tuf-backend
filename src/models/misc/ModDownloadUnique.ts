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

class ModDownloadUnique extends Model<
  InferAttributes<ModDownloadUnique>,
  InferCreationAttributes<ModDownloadUnique>
> {
  declare id: CreationOptional<number>;
  declare modId: ForeignKey<Mod['id']>;
  declare ipHash: string;
  declare dayDate: string;
  declare createdAt: CreationOptional<Date>;
}

ModDownloadUnique.init(
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
    ipHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    dayDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'mod_download_uniques',
    updatedAt: false,
    indexes: [
      {unique: true, fields: ['modId', 'ipHash', 'dayDate'], name: 'mod_download_uniques_unique'},
      {fields: ['dayDate'], name: 'idx_mod_download_uniques_day'},
    ],
  },
);

export default ModDownloadUnique;
