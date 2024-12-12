import {Model, DataTypes} from 'sequelize';
import sequelize from '../config/db';

interface PassSubmissionAttributes {
  id: number;
  levelId: string;
  speed: number;
  passer: string;
  feelingDifficulty: string;
  title: string;
  rawVideoId: string;
  rawTime: Date;
  submitterDiscordUsername?: string;
  submitterEmail?: string;
  submitterDiscordId?: string;
  submitterDiscordAvatar?: string;
  levelDifficultyIcon?: string;
  status: string;
  assignedPlayerId?: number;
}

type PassSubmissionCreationAttributes = Omit<PassSubmissionAttributes, 'id'>;

class PassSubmission extends Model<
  PassSubmissionAttributes,
  PassSubmissionCreationAttributes
> {
  declare id: number;
  declare levelId: string;
  declare speed: number;
  declare passer: string;
  declare feelingDifficulty: string;
  declare title: string;
  declare rawVideoId: string;
  declare rawTime: Date;
  declare submitterDiscordUsername?: string;
  declare submitterEmail?: string;
  declare submitterDiscordId?: string;
  declare submitterDiscordAvatar?: string;
  declare levelDifficultyIcon?: string;
  declare status: string;
  declare assignedPlayerId?: number;

  // Associations
  declare judgements?: PassSubmissionJudgements;
  declare flags?: PassSubmissionFlags;
}

class PassSubmissionJudgements extends Model {
  declare passSubmissionId: number;
  declare earlyDouble: number;
  declare earlySingle: number;
  declare ePerfect: number;
  declare perfect: number;
  declare lPerfect: number;
  declare lateSingle: number;
  declare lateDouble: number;
}

class PassSubmissionFlags extends Model {
  declare passSubmissionId: number;
  declare is12k: boolean;
  declare isNHT: boolean;
  declare is16k: boolean;
  declare isLegacy: boolean;
}

PassSubmission.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    levelId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    speed: {
      type: DataTypes.FLOAT,
      defaultValue: 1,
    },
    passer: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    feelingDifficulty: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    rawVideoId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    rawTime: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    submitterDiscordUsername: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    submitterDiscordId: {
      type: DataTypes.STRING,
      allowNull: true,
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
  },
  {
    sequelize,
    tableName: 'pass_submissions',
    indexes: [
      {fields: ['passer']},
      {fields: ['rawVideoId']},
      {fields: ['status']},
      {fields: ['assignedPlayerId']},
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
    is12k: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    isNHT: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    is16k: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    isLegacy: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  },
  {
    sequelize,
    tableName: 'pass_submission_flags',
  },
);

// Set up associations after all models are initialized
PassSubmission.hasOne(PassSubmissionJudgements, {
  foreignKey: 'passSubmissionId',
  as: 'judgements',
});

PassSubmission.hasOne(PassSubmissionFlags, {
  foreignKey: 'passSubmissionId',
  as: 'flags',
});

PassSubmissionJudgements.belongsTo(PassSubmission, {
  foreignKey: 'passSubmissionId',
});

PassSubmissionFlags.belongsTo(PassSubmission, {
  foreignKey: 'passSubmissionId',
});

export {PassSubmission, PassSubmissionJudgements, PassSubmissionFlags};
