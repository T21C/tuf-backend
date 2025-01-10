import {DataTypes} from 'sequelize';
import sequelize from '../config/db';
import BaseModel from './BaseModel';
import Player from './Player';
import Level from './Level';

class PassSubmission extends BaseModel {
  declare passer: string;
  declare videoLink: string;
  declare status: 'pending' | 'approved' | 'declined';
  declare assignedPlayerId: number | null;
  declare levelId: number;
  declare speed: number | null;
  declare is12K: boolean;
  declare is16K: boolean;
  declare isNoHoldTap: boolean;
  declare isWorldsFirst: boolean;
  declare accuracy: number | null;
  declare scoreV2: number | null;
  declare feelingDifficulty: string | null;
  declare title: string | null;
  declare rawTime: Date | null;
  declare submitterDiscordUsername: string | null;
  declare submitterDiscordId: string | null;
  declare submitterDiscordPfp: string | null;

  // Virtual fields from associations
  declare assignedPlayer?: Player;
  declare level?: Level;
  declare judgements?: PassSubmissionJudgements;
  declare flags?: PassSubmissionFlags;
}

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
  public is12K!: boolean;
  public isNoHoldTap!: boolean;
  public is16K!: boolean;
}

PassSubmission.init(
  {
    passer: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    videoLink: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('pending', 'approved', 'declined'),
      defaultValue: 'pending',
    },
    assignedPlayerId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'players',
        key: 'id',
      },
    },
    levelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'levels',
        key: 'id',
      },
    },
    speed: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
    is12K: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    is16K: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    isNoHoldTap: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    isWorldsFirst: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    accuracy: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
    scoreV2: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
    feelingDifficulty: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    title: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    rawTime: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    submitterDiscordUsername: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    submitterEmail: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    submitterDiscordId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    submitterDiscordPfp: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'pass_submissions',
    indexes: [
      {fields: ['passer']},
      {fields: ['videoLink']},
      {fields: ['status']},
      {fields: ['assignedPlayerId']},
      {fields: ['levelId']},
    ],
  },
);

PassSubmissionJudgements.init(
  {
    passSubmissionId: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: {
        model: 'pass_submissions',
        key: 'id',
      },
    },
    earlyDouble: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    earlySingle: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    ePerfect: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    perfect: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    lPerfect: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    lateSingle: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    lateDouble: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    tableName: 'pass_submission_judgements',
  },
);

PassSubmissionFlags.init(
  {
    passSubmissionId: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: {
        model: 'pass_submissions',
        key: 'id',
      },
    },
    is12K: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    isNoHoldTap: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    is16K: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  },
  {
    sequelize,
    tableName: 'pass_submission_flags',
  },
);

export {PassSubmission, PassSubmissionJudgements, PassSubmissionFlags};
