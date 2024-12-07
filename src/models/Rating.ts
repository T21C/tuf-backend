import { DataTypes } from 'sequelize';
import sequelize from '../config/db';
import BaseModel from './BaseModel';

class Rating extends BaseModel {
  public levelId!: number;
  public currentDiff!: string;
  public lowDiff!: boolean;
  public rerateNum!: string;
  public requesterFR!: string;
  public average!: string;
  public comments!: string;
  public rerateReason!: string;
}

Rating.init({
  levelId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    references: {
      model: 'levels',
      key: 'id'
    }
  },
  currentDiff: {
    type: DataTypes.STRING,
    defaultValue: '0'
  },
  lowDiff: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  rerateNum: {
    type: DataTypes.STRING,
    defaultValue: ''
  },
  requesterFR: {
    type: DataTypes.STRING,
    defaultValue: ''
  },
  average: {
    type: DataTypes.STRING,
    defaultValue: '0'
  },
  comments: {
    type: DataTypes.TEXT,
    defaultValue: ''
  },
  rerateReason: {
    type: DataTypes.TEXT,
    defaultValue: ''
  }
}, {
  sequelize,
  tableName: 'ratings'
});

export default Rating; 