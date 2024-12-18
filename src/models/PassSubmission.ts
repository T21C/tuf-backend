import {DataTypes, Model, Optional} from 'sequelize';
import sequelize from '../config/db';
import {IPassSubmission, IPassSubmissionFlags, IPassSubmissionJudgements} from '../interfaces/models';
import Player from './Player';
import Level from './Level';

type PassSubmissionAttributes = IPassSubmission;
type PassSubmissionCreationAttributes = Optional<
  PassSubmissionAttributes,
  'id' | 'createdAt' | 'updatedAt'
>;

class PassSubmission
  extends Model<PassSubmissionAttributes, PassSubmissionCreationAttributes>
  implements PassSubmissionAttributes
{
  declare id: number;
  declare levelId: number;
  declare speed: number;
  declare passer: string;
  declare feelingDifficulty: string;
  declare title: string;
  declare videoLink: string;
  declare rawTime: Date;
  declare submitterDiscordUsername?: string;
  declare submitterEmail?: string;
  declare submitterDiscordId?: string;
  declare submitterDiscordPfp?: string;
  declare status: 'pending' | 'approved' | 'declined';
  declare assignedPlayerId?: number | null;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare assignedPlayer?: Player;
  declare judgements?: PassSubmissionJudgements;
  declare flags?: PassSubmissionFlags;
  declare level?: Level;
}

class PassSubmissionJudgements 
  extends Model<IPassSubmissionJudgements>
  implements IPassSubmissionJudgements 
{
  declare passSubmissionId: number;
  declare earlyDouble: number;
  declare earlySingle: number;
  declare ePerfect: number;
  declare perfect: number;
  declare lPerfect: number;
  declare lateSingle: number;
  declare lateDouble: number;
}

class PassSubmissionFlags 
  extends Model<IPassSubmissionFlags>
  implements IPassSubmissionFlags 
{
  declare passSubmissionId: number;
  declare is12K: boolean;
  declare isNoHoldTap: boolean;
  declare is16K: boolean;
}

PassSubmission.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
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
    videoLink: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    rawTime: {
      type: DataTypes.DATE,
      allowNull: false,
      get() {
        const date = this.getDataValue('rawTime');
        return date instanceof Date && !isNaN(date.getTime()) ? date : null;
      },
      set(value: any) {
        if (!value) {
          const defaultDate = new Date();
          this.setDataValue('rawTime', defaultDate);
          return;
        }

        const date = new Date(value);
        if (date instanceof Date && !isNaN(date.getTime())) {
          this.setDataValue('rawTime', date);
        } else {
          const defaultDate = new Date();
          this.setDataValue('rawTime', defaultDate);
        }
      },
    },
    submitterDiscordUsername: {
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

// Initialize models with their attributes
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

// Define associations
PassSubmission.hasOne(PassSubmissionJudgements, {
  foreignKey: 'passSubmissionId',
  as: 'judgements',
  onDelete: 'CASCADE',
  onUpdate: 'CASCADE',
});

PassSubmission.hasOne(PassSubmissionFlags, {
  foreignKey: 'passSubmissionId',
  as: 'flags',
  onDelete: 'CASCADE',
  onUpdate: 'CASCADE',
});

PassSubmissionJudgements.belongsTo(PassSubmission, {
  foreignKey: 'passSubmissionId',
  onDelete: 'CASCADE',
  onUpdate: 'CASCADE',
});

PassSubmissionFlags.belongsTo(PassSubmission, {
  foreignKey: 'passSubmissionId',
  onDelete: 'CASCADE',
  onUpdate: 'CASCADE',
});

// Level and Player associations are handled in associations.ts

export {PassSubmission, PassSubmissionJudgements, PassSubmissionFlags};
