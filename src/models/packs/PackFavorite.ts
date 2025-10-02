import { Model, DataTypes, Optional } from 'sequelize';
import sequelize from '../../config/db.js';
import User from '../auth/User.js';
import LevelPack from './LevelPack.js';

export interface IPackFavorite {
  id: number;
  userId: string;
  packId: number;
  createdAt: Date;
  updatedAt: Date;
}

type PackFavoriteAttributes = IPackFavorite;
type PackFavoriteCreationAttributes = Optional<
  PackFavoriteAttributes,
  'id' | 'createdAt' | 'updatedAt'
>;

class PackFavorite
  extends Model<PackFavoriteAttributes, PackFavoriteCreationAttributes>
  implements IPackFavorite
{
  declare id: number;
  declare userId: string;
  declare packId: number;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Virtual fields from associations
  declare user?: User;
  declare pack?: LevelPack;
}

PackFavorite.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    packId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'level_packs',
        key: 'id',
      },
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'pack_favorites',
    timestamps: true,
    indexes: [
      {
        fields: ['userId'],
      },
      {
        fields: ['packId'],
      },
      {
        fields: ['userId', 'packId'],
        unique: true,
      },
    ],
  }
);

export default PackFavorite;
