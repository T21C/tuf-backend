import {DataTypes, Model, Optional} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('tournaments');

export interface TournamentPlacementAttributes {
  id: number;
  tournamentId: number;
  tierId: number;
  displayName: string;
  playerId: number | null;
  creatorId: number | null;
  withdrew: boolean;
  isPending: boolean;
  teamKey: string | null;
  teamName: string | null;
  positionInTier: number;
  createdAt: Date;
  updatedAt: Date;
}

type TournamentPlacementCreationAttributes = Optional<
  TournamentPlacementAttributes,
  | 'id'
  | 'playerId'
  | 'creatorId'
  | 'withdrew'
  | 'isPending'
  | 'teamKey'
  | 'teamName'
  | 'positionInTier'
  | 'createdAt'
  | 'updatedAt'
>;

class TournamentPlacement
  extends Model<TournamentPlacementAttributes, TournamentPlacementCreationAttributes>
  implements TournamentPlacementAttributes
{
  declare id: number;
  declare tournamentId: number;
  declare tierId: number;
  declare displayName: string;
  declare playerId: number | null;
  declare creatorId: number | null;
  declare withdrew: boolean;
  declare isPending: boolean;
  declare teamKey: string | null;
  declare teamName: string | null;
  declare positionInTier: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

TournamentPlacement.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    tournamentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    tierId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    displayName: {
      type: DataTypes.STRING(255),
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
    withdrew: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    isPending: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    teamKey: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    teamName: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    positionInTier: {
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
    tableName: 'tournament_placements',
  },
);

export default TournamentPlacement;
