import {DataTypes, Model, Optional} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('tournaments');

export interface EquippedCosmeticAttributes {
  id: number;
  playerId: number | null;
  creatorId: number | null;
  rewardType: string;
  entitlementId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

type EquippedCosmeticCreationAttributes = Optional<
  EquippedCosmeticAttributes,
  'id' | 'playerId' | 'creatorId' | 'rewardType' | 'entitlementId' | 'createdAt' | 'updatedAt'
>;

class EquippedCosmetic
  extends Model<EquippedCosmeticAttributes, EquippedCosmeticCreationAttributes>
  implements EquippedCosmeticAttributes
{
  declare id: number;
  declare playerId: number | null;
  declare creatorId: number | null;
  declare rewardType: string;
  declare entitlementId: number | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

EquippedCosmetic.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    playerId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    creatorId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    rewardType: {
      type: DataTypes.STRING(64),
      allowNull: false,
      defaultValue: 'avatar_frame',
    },
    entitlementId: {
      type: DataTypes.INTEGER,
      allowNull: true,
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
    tableName: 'equipped_cosmetics',
  },
);

export default EquippedCosmetic;
