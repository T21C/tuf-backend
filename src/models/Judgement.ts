import { DataTypes } from 'sequelize';
import sequelize from '../config/db';
import BaseModel from './BaseModel';
import { IJudgement } from '../types/models';

class Judgement extends BaseModel implements IJudgement {
  public passId!: number;
  public earlyDouble!: number;
  public earlySingle!: number;
  public ePerfect!: number;
  public perfect!: number;
  public lPerfect!: number;
  public lateSingle!: number;
  public lateDouble!: number;
}

Judgement.init({
  passId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    references: {
      model: 'passes',
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
  tableName: 'judgements'
});

export default Judgement;