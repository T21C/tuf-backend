import { Model, DataTypes } from 'sequelize';
import sequelize from '../../config/db.js';
import BaseModel from '../BaseModel.js';
import LevelSubmission from './LevelSubmission.js';
import Creator from '../credits/Creator.js';

class LevelSubmissionCreatorRequest extends BaseModel {
  declare id: number;
  declare submissionId: number;
  declare creatorName: string;
  declare creatorId: number | null;
  declare role: 'charter' | 'vfxer';
  declare isNewRequest: boolean;

  // Virtual fields from associations
  declare submission?: LevelSubmission;
  declare creator?: Creator;

  static associate(models: any) {
    LevelSubmissionCreatorRequest.belongsTo(models.LevelSubmission, {
      foreignKey: 'submissionId',
      as: 'submission'
    });
    LevelSubmissionCreatorRequest.belongsTo(models.Creator, {
      foreignKey: 'creatorId',
      as: 'creator'
    });
  }
}

LevelSubmissionCreatorRequest.init({
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
  creatorName: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  creatorId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'creators',
      key: 'id'
    }
  },
  role: {
    type: DataTypes.ENUM('charter', 'vfxer'),
    allowNull: false
  },
  isNewRequest: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  }
}, {
  sequelize,
  modelName: 'LevelSubmissionCreatorRequest',
  tableName: 'level_submission_creator_requests',
  timestamps: true
});

export default LevelSubmissionCreatorRequest; 