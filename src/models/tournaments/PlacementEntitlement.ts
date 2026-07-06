import {DataTypes, Model, Optional} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('tournaments');

export interface PlacementEntitlementAttributes {
  id: number;
  rewardId: number;
  placementId: number;
  playerId: number | null;
  creatorId: number | null;
  grantedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

type PlacementEntitlementCreationAttributes = Optional<
  PlacementEntitlementAttributes,
  'id' | 'playerId' | 'creatorId' | 'grantedAt' | 'createdAt' | 'updatedAt'
>;

class PlacementEntitlement
  extends Model<PlacementEntitlementAttributes, PlacementEntitlementCreationAttributes>
  implements PlacementEntitlementAttributes
{
  declare id: number;
  declare rewardId: number;
  declare placementId: number;
  declare playerId: number | null;
  declare creatorId: number | null;
  declare grantedAt: Date;
  declare createdAt: Date;
  declare updatedAt: Date;
}

PlacementEntitlement.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    rewardId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    placementId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    playerId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    creatorId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    grantedAt: {
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
    tableName: 'placement_entitlements',
  },
);

export default PlacementEntitlement;
