import { DataTypes } from 'sequelize';
import sequelize from '../config/db';
import BaseModel from './BaseModel';

class PassSubmission extends BaseModel {
  public levelId!: string;
  public speed!: number;
  public passer!: string;
  public feelingDifficulty!: string;
  public title!: string;
  public rawVideoId!: string;
  public rawTime!: Date;
  public submitterDiscordUsername!: string;
  public submitterEmail!: string;
  public status!: string;
  public judgements!: any;
  public flags!: any;
}

PassSubmission.init({
  levelId: {
    type: DataTypes.STRING,
    allowNull: false
  },
  speed: {
    type: DataTypes.FLOAT,
    defaultValue: 1
  },
  passer: {
    type: DataTypes.STRING,
    allowNull: false
  },
  feelingDifficulty: {
    type: DataTypes.STRING,
    allowNull: false
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false
  },
  rawVideoId: {
    type: DataTypes.STRING,
    allowNull: false
  },
  rawTime: {
    type: DataTypes.DATE,
    allowNull: false
  },
  submitterDiscordUsername: {
    type: DataTypes.STRING
  },
  submitterEmail: {
    type: DataTypes.STRING
  },
  status: {
    type: DataTypes.ENUM('pending', 'approved', 'declined'),
    defaultValue: 'pending'
  }
}, {
  sequelize,
  tableName: 'pass_submissions',
  indexes: [
    { fields: ['passer'] },
    { fields: ['rawVideoId'] },
    { fields: ['status'] }
  ]
});

// Create associated models for complex fields
class PassSubmissionJudgements extends BaseModel {
  public passSubmissionId!: number;
  public earlyDouble!: number;
  public earlySingle!: number;
  public ePerfect!: number;
  public perfect!: number;
  public lPerfect!: number;
  public lateSingle!: number;
  public lateDouble!: number;
}

class PassSubmissionFlags extends BaseModel {
  public passSubmissionId!: number;
  public is12k!: boolean;
  public isNHT!: boolean;
  public is16k!: boolean;
  public isLegacy!: boolean;
}

// Initialize associated models
PassSubmissionJudgements.init({
  passSubmissionId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    references: {
      model: PassSubmission,
      key: 'id'
    }
  },
  earlyDouble: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  earlySingle: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  ePerfect: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  perfect: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  lPerfect: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  lateSingle: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  lateDouble: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  }
}, {
  sequelize,
  tableName: 'pass_submission_judgements'
});

PassSubmissionFlags.init({
  passSubmissionId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    references: {
      model: PassSubmission,
      key: 'id'
    }
  },
  is12k: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  isNHT: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  is16k: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  isLegacy: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
}, {
  sequelize,
  tableName: 'pass_submission_flags'
});

// Set up relationships
PassSubmission.hasOne(PassSubmissionJudgements, { foreignKey: 'passSubmissionId' });
PassSubmission.hasOne(PassSubmissionFlags, { foreignKey: 'passSubmissionId' });

export { PassSubmission, PassSubmissionJudgements, PassSubmissionFlags };
