import { Model, DataTypes } from 'sequelize';
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
  status: string;
  assignedPlayerId?: number;
}

interface PassSubmissionCreationAttributes extends Omit<PassSubmissionAttributes, 'id'> {}

class PassSubmission extends Model<PassSubmissionAttributes, PassSubmissionCreationAttributes> {
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
  declare status: string;
  declare assignedPlayerId?: number;

  // Virtual fields for associations
  declare PassSubmissionJudgement?: PassSubmissionJudgements;
  declare PassSubmissionFlag?: PassSubmissionFlags;
}

PassSubmission.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
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
    type: DataTypes.STRING,
    allowNull: true
  },
  submitterEmail: {
    type: DataTypes.STRING,
    allowNull: true
  },
  status: {
    type: DataTypes.ENUM('pending', 'approved', 'declined'),
    defaultValue: 'pending'
  },
  assignedPlayerId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'players',
      key: 'id'
    }
  }
}, {
  sequelize,
  tableName: 'pass_submissions',
  indexes: [
    { fields: ['passer'] },
    { fields: ['rawVideoId'] },
    { fields: ['status'] },
    { fields: ['assignedPlayerId'] }
  ]
});

// Create associated models for complex fields
interface PassSubmissionJudgementsAttributes {
  passSubmissionId: number;
  earlyDouble: number;
  earlySingle: number;
  ePerfect: number;
  perfect: number;
  lPerfect: number;
  lateSingle: number;
  lateDouble: number;
}

class PassSubmissionJudgements extends Model<PassSubmissionJudgementsAttributes> {
  declare passSubmissionId: number;
  declare earlyDouble: number;
  declare earlySingle: number;
  declare ePerfect: number;
  declare perfect: number;
  declare lPerfect: number;
  declare lateSingle: number;
  declare lateDouble: number;
}

interface PassSubmissionFlagsAttributes {
  passSubmissionId: number;
  is12k: boolean;
  isNHT: boolean;
  is16k: boolean;
  isLegacy: boolean;
}

class PassSubmissionFlags extends Model<PassSubmissionFlagsAttributes> {
  declare passSubmissionId: number;
  declare is12k: boolean;
  declare isNHT: boolean;
  declare is16k: boolean;
  declare isLegacy: boolean;
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
PassSubmission.hasOne(PassSubmissionJudgements, { foreignKey: 'passSubmissionId', as: 'PassSubmissionJudgement' });
PassSubmission.hasOne(PassSubmissionFlags, { foreignKey: 'passSubmissionId', as: 'PassSubmissionFlag' });

export { PassSubmission, PassSubmissionJudgements, PassSubmissionFlags };
