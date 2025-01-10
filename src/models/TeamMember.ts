import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '../config/db';

interface TeamMemberAttributes {
  id: number;
  teamId: number;
  creatorId: number;
  createdAt: Date;
  updatedAt: Date;
}

type TeamMemberCreationAttributes = Optional<TeamMemberAttributes, 'id' | 'createdAt' | 'updatedAt'>;

class TeamMember extends Model<TeamMemberAttributes, TeamMemberCreationAttributes> implements TeamMemberAttributes {
  declare id: number;
  declare teamId: number;
  declare creatorId: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

TeamMember.init(
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
        key: 'id'
      }
    },
    creatorId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'creators',
        key: 'id'
      }
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    }
  },
  {
    sequelize,
    tableName: 'team_members',
    indexes: [
      {
        unique: true,
        fields: ['teamId', 'creatorId']
      }
    ]
  }
);

export default TeamMember; 