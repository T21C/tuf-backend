import {Model, DataTypes} from 'sequelize';
import Team from './Team.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('credits');

export class TeamAlias extends Model {
  declare public id: number;
  declare public teamId: number;
  declare public name: string;
  declare public readonly createdAt: Date;
  declare public readonly updatedAt: Date;

  // Associations
  declare public team: Team;
}

TeamAlias.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    teamId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'teams',
        key: 'id',
      },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    sequelize: sequelize,
    tableName: 'team_aliases',
    timestamps: true,
  }
);
