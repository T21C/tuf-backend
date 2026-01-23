import {Model, DataTypes, Optional} from 'sequelize';
import LevelSubmission from './LevelSubmission.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('submissions');

type LevelSubmissionEvidenceAttributes = {
  id: number;
  submissionId: number;
  link: string;
  type: 'song' | 'artist';
  requestId: number | null;
  createdAt: Date;
  updatedAt: Date;
};

type LevelSubmissionEvidenceCreationAttributes = Optional<LevelSubmissionEvidenceAttributes, 'id' | 'createdAt' | 'updatedAt'>;

class LevelSubmissionEvidence extends Model<LevelSubmissionEvidenceAttributes, LevelSubmissionEvidenceCreationAttributes> {
  declare id: number;
  declare submissionId: number;
  declare link: string;
  declare type: 'song' | 'artist';
  declare requestId: number | null;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare submission: LevelSubmission;
}

LevelSubmissionEvidence.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    submissionId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'level_submissions',
        key: 'id',
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    link: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM('song', 'artist'),
      allowNull: false,
    },
    requestId: {
      type: DataTypes.INTEGER,
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
    tableName: 'level_submission_evidence',
    indexes: [
      {fields: ['submissionId']},
      {fields: ['type']},
      {fields: ['requestId']},
    ],
  },
);

export default LevelSubmissionEvidence;
