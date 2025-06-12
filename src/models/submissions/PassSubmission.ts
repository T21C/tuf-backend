import {DataTypes} from 'sequelize';
import sequelize from '../../config/db.js';
import BaseModel from '../BaseModel.js';
import Player from '../players/Player.js';
import Level from '../levels/Level.js';
import { calcAcc } from '../../utils/CalcAcc.js';
import User from '../auth/User.js';
class PassSubmission extends BaseModel {
  declare passer: string;
  declare passerId: number | null;
  declare passerRequest: boolean;
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
  declare userId: string | null; 
  // Virtual fields from associations
  declare assignedPlayer?: Player;
  declare passerPlayer?: Player;
  declare level?: Level;
  declare judgements?: PassSubmissionJudgements;
  declare flags?: PassSubmissionFlags;
  declare passSubmitter?: User;
}

class PassSubmissionJudgements extends BaseModel {
  declare passSubmissionId: number;
  declare earlyDouble: number;
  declare earlySingle: number;
  declare ePerfect: number;
  declare perfect: number;
  declare lPerfect: number;
  declare lateSingle: number;
  declare lateDouble: number;
  declare accuracy?: number;
}

class PassSubmissionFlags extends BaseModel {
  declare passSubmissionId: number;
  declare is12K: boolean;
  declare isNoHoldTap: boolean;
  declare is16K: boolean;
}

PassSubmission.init(
  {
    passer: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    passerId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'players',
        key: 'id',
      },
    },
    passerRequest: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    videoLink: {
      type: DataTypes.TEXT,
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
      type: DataTypes.VIRTUAL,
      get() {
        return this.judgements?.accuracy;
      },
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
      type: DataTypes.TEXT,
      allowNull: true,
    },
    submitterEmail: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    submitterDiscordId: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    submitterDiscordPfp: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id',
      },
    },
  },
  {
    sequelize,
    tableName: 'pass_submissions',
    indexes: [
      {fields: ['passer']},
      {fields: ['passerId']},
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
    accuracy: {
      type: DataTypes.VIRTUAL,
      get() {
        return calcAcc(this);
      },
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

PassSubmission.belongsTo(User, {
  foreignKey: 'userId',
  as: 'passSubmitter',
});

export {PassSubmission, PassSubmissionJudgements, PassSubmissionFlags};
