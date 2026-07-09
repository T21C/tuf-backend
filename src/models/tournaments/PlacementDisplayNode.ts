import {DataTypes, Model, Optional} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('tournaments');

export type PlacementDisplayNodeType = 'group' | 'credit' | 'seriesRef' | 'tournamentRef';
export type PlacementDisplayMode = 'defaultHierarchy' | 'customLayers';

export interface PlacementDisplayNodeAttributes {
  id: number;
  playerId: number | null;
  creatorId: number | null;
  parentId: number | null;
  sortOrder: number;
  visible: boolean;
  nodeType: PlacementDisplayNodeType;
  refId: number | null;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type PlacementDisplayNodeCreationAttributes = Optional<
  PlacementDisplayNodeAttributes,
  'id' | 'playerId' | 'creatorId' | 'parentId' | 'sortOrder' | 'visible' | 'refId' | 'label' | 'createdAt' | 'updatedAt'
>;

class PlacementDisplayNode
  extends Model<PlacementDisplayNodeAttributes, PlacementDisplayNodeCreationAttributes>
  implements PlacementDisplayNodeAttributes
{
  declare id: number;
  declare playerId: number | null;
  declare creatorId: number | null;
  declare parentId: number | null;
  declare sortOrder: number;
  declare visible: boolean;
  declare nodeType: PlacementDisplayNodeType;
  declare refId: number | null;
  declare label: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

PlacementDisplayNode.init(
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
    parentId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    visible: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    nodeType: {
      type: DataTypes.ENUM('group', 'credit', 'seriesRef', 'tournamentRef'),
      allowNull: false,
    },
    refId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    label: {
      type: DataTypes.STRING(255),
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
    tableName: 'placement_display_nodes',
  },
);

export default PlacementDisplayNode;
