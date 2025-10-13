import {DataTypes, Model} from 'sequelize';
import sequelize from '../../config/db.js';
import {ITeam} from '../../interfaces/models/index.js';
import { TeamAlias } from './TeamAlias.js';
import Creator from './Creator.js';
import TeamMember from './TeamMember.js';

class Team extends Model implements ITeam {
  declare id: number;
  declare name: string;
  declare description?: string;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare teamCreators: Creator[];
  declare teamAliases: TeamAlias[];
  declare teamMembers: TeamMember[];
  declare levels: any[];
}

Team.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    description: {
      type: DataTypes.TEXT,
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
    modelName: 'Team',
    tableName: 'teams',
  },
);

export default Team;
