import {DataTypes, Model} from 'sequelize';
import sequelize from '../config/db.js';
import {IJudgement} from '../interfaces/models/index.js';
import { calcAcc } from '../misc/CalcAcc.js';

class Judgement extends Model<IJudgement> implements IJudgement {
  declare id: number;
  declare earlyDouble: number;
  declare earlySingle: number;
  declare ePerfect: number;
  declare perfect: number;
  declare lPerfect: number;
  declare lateSingle: number;
  declare lateDouble: number;
  declare accuracy?: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Judgement.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: {
        model: 'passes',
        key: 'id',
      },
    },
    earlyDouble: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    earlySingle: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    ePerfect: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    perfect: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    lPerfect: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    lateSingle: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    lateDouble: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
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
    tableName: 'judgements',
  },
);

export default Judgement;
