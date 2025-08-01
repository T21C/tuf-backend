import {Model, DataTypes} from 'sequelize';
import sequelize from '../../config/db.js';
import Team from './Team.js';

export class TeamAlias extends Model {
  public id!: number;
  public teamId!: number;
  public name!: string;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
  
  // Associations
  public team!: Team;
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