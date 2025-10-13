import { DataTypes } from 'sequelize';
import sequelize from '../../config/db.js';
import BaseModel from '../BaseModel.js';
import LevelSubmission from './LevelSubmission.js';
import Team from '../credits/Team.js';

class LevelSubmissionTeamRequest extends BaseModel {
  declare id: number;
  declare submissionId: number;
  declare teamName: string;
  declare teamId: number | null;
  declare isNewRequest: boolean;

  // Virtual fields from associations
  declare submission?: LevelSubmission;
  declare team?: Team;

  static associate(models: any) {
    LevelSubmissionTeamRequest.belongsTo(models.LevelSubmission, {
      foreignKey: 'submissionId',
      as: 'submission'
    });
    LevelSubmissionTeamRequest.belongsTo(models.Team, {
      foreignKey: 'teamId',
      as: 'team'
    });
  }
}

LevelSubmissionTeamRequest.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  submissionId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'level_submissions',
      key: 'id'
    }
  },
  teamName: {
    type: DataTypes.STRING,
    allowNull: false
  },
  teamId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'teams',
      key: 'id'
    }
  },
  isNewRequest: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  }
}, {
  sequelize,
  modelName: 'LevelSubmissionTeamRequest',
  tableName: 'level_submission_team_requests',
  timestamps: true
});

export default LevelSubmissionTeamRequest;
