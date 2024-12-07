import { DataTypes } from 'sequelize';
import sequelize from '../config/db';
import BaseModel from './BaseModel';

class RerateSubmission extends BaseModel {
  public levelId!: string;
  public song!: string;
  public artists!: string;
  public creators!: string;
  public videoLink!: string;
  public downloadLink!: string;
  public originalDiff!: string;
  public isLowDiff!: boolean;
  public rerateValue!: number;
  public requesterFR!: string;
  public average!: number;
  public comments!: string;
}

RerateSubmission.init({
  levelId: {
    type: DataTypes.STRING,
    allowNull: false
  },
  song: {
    type: DataTypes.STRING,
    allowNull: false
  },
  artists: {
    type: DataTypes.STRING,
    allowNull: false
  },
  creators: {
    type: DataTypes.STRING,
    allowNull: false
  },
  videoLink: {
    type: DataTypes.STRING,
    allowNull: false
  },
  downloadLink: {
    type: DataTypes.STRING,
    allowNull: false
  },
  originalDiff: {
    type: DataTypes.STRING,
    allowNull: false
  },
  isLowDiff: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  rerateValue: {
    type: DataTypes.FLOAT,
    allowNull: false
  },
  requesterFR: {
    type: DataTypes.STRING,
    allowNull: false
  },
  average: {
    type: DataTypes.FLOAT,
    allowNull: false
  },
  comments: {
    type: DataTypes.TEXT,
    defaultValue: ''
  }
}, {
  sequelize,
  tableName: 'rerate_submissions',
  indexes: [
    { fields: ['levelId'] },
    { fields: ['song'] },
    { fields: ['artists'] },
    { fields: ['creators'] },
    { fields: ['requesterFR'] }
  ]
});

export default RerateSubmission;
