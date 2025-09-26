import {Model, DataTypes, Optional} from 'sequelize';
import sequelize from '../../config/db.js';
import LevelPack from './LevelPack.js';
import Level from '../levels/Level.js';

export interface ILevelPackItem {
  id: number;
  packId: number;
  levelId: number;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

type LevelPackItemAttributes = ILevelPackItem;
type LevelPackItemCreationAttributes = Optional<
  LevelPackItemAttributes,
  'id' | 'createdAt' | 'updatedAt'
>;

class LevelPackItem
  extends Model<LevelPackItemAttributes, LevelPackItemCreationAttributes>
  implements ILevelPackItem
{
  declare id: number;
  declare packId: number;
  declare levelId: number;
  declare sortOrder: number;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Virtual fields from associations
  declare pack?: LevelPack;
  declare level?: Level;
}

LevelPackItem.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    packId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'level_packs',
        key: 'id',
      },
      onDelete: 'CASCADE',
      comment: 'Reference to the level pack',
    },
    levelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'levels',
        key: 'id',
      },
      onDelete: 'CASCADE',
      comment: 'Reference to the level',
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Order of the level within the pack (for reorderable functionality)',
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
    tableName: 'level_pack_items',
    timestamps: true,
    indexes: [
      {
        fields: ['packId'],
      },
      {
        fields: ['levelId'],
      },
      {
        fields: ['sortOrder'],
      },
      {
        fields: ['packId', 'sortOrder'],
      },
    ],
  }
);

export default LevelPackItem;
