import {DataTypes, Model, Optional} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('tournaments');

export interface TournamentPlacementCreditAttributes {
  id: number;
  placementId: number;
  playerId: number | null;
  creatorId: number | null;
  isGuest: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

type TournamentPlacementCreditCreationAttributes = Optional<
  TournamentPlacementCreditAttributes,
  'id' | 'playerId' | 'creatorId' | 'isGuest' | 'sortOrder' | 'createdAt' | 'updatedAt'
>;

class TournamentPlacementCredit
  extends Model<TournamentPlacementCreditAttributes, TournamentPlacementCreditCreationAttributes>
  implements TournamentPlacementCreditAttributes
{
  declare id: number;
  declare placementId: number;
  declare playerId: number | null;
  declare creatorId: number | null;
  declare isGuest: boolean;
  declare sortOrder: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

TournamentPlacementCredit.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
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
    isGuest: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    sortOrder: {
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
    tableName: 'tournament_placement_credits',
  },
);

export default TournamentPlacementCredit;
