import {DataTypes, Model, Optional} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('tournaments');

export interface PlacementRewardAttributes {
  id: number;
  tournamentId: number | null;
  seriesId: number | null;
  tierId: number | null;
  maxRankWeight: number | null;
  requireNotWithdrew: boolean;
  requireFinalResults: boolean;
  rewardType: string;
  assetId: string | null;
  assetUrl: string | null;
  config: Record<string, unknown> | null;
  label: string;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
}

type PlacementRewardCreationAttributes = Optional<
  PlacementRewardAttributes,
  | 'id'
  | 'tournamentId'
  | 'seriesId'
  | 'tierId'
  | 'maxRankWeight'
  | 'requireNotWithdrew'
  | 'requireFinalResults'
  | 'rewardType'
  | 'assetId'
  | 'assetUrl'
  | 'config'
  | 'priority'
  | 'createdAt'
  | 'updatedAt'
>;

class PlacementReward
  extends Model<PlacementRewardAttributes, PlacementRewardCreationAttributes>
  implements PlacementRewardAttributes
{
  declare id: number;
  declare tournamentId: number | null;
  declare seriesId: number | null;
  declare tierId: number | null;
  declare maxRankWeight: number | null;
  declare requireNotWithdrew: boolean;
  declare requireFinalResults: boolean;
  declare rewardType: string;
  declare assetId: string | null;
  declare assetUrl: string | null;
  declare config: Record<string, unknown> | null;
  declare label: string;
  declare priority: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

PlacementReward.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    tournamentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    seriesId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    tierId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    maxRankWeight: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    requireNotWithdrew: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    requireFinalResults: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    rewardType: {
      type: DataTypes.STRING(64),
      allowNull: false,
      defaultValue: 'avatar_frame',
    },
    assetId: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    assetUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    config: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    label: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    priority: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
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
    tableName: 'placement_rewards',
  },
);

export default PlacementReward;
