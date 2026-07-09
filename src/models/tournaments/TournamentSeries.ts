import {DataTypes, Model, Optional} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('tournaments');

export interface TournamentSeriesAttributes {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  sortWeight: number;
  createdAt: Date;
  updatedAt: Date;
}

type TournamentSeriesCreationAttributes = Optional<
  TournamentSeriesAttributes,
  'id' | 'description' | 'logoUrl' | 'sortWeight' | 'createdAt' | 'updatedAt'
>;

class TournamentSeries
  extends Model<TournamentSeriesAttributes, TournamentSeriesCreationAttributes>
  implements TournamentSeriesAttributes
{
  declare id: number;
  declare slug: string;
  declare name: string;
  declare description: string | null;
  declare logoUrl: string | null;
  declare sortWeight: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

TournamentSeries.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    slug: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    logoUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    sortWeight: {
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
    tableName: 'tournament_series',
  },
);

export default TournamentSeries;
