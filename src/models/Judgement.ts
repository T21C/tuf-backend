import {DataTypes, Model, Optional} from 'sequelize';
import sequelize from '../config/db';
import {IJudgement} from '../interfaces/models';
import Pass from './Pass';

type JudgementCreationAttributes = Optional<
  IJudgement,
  'id' | 'createdAt' | 'updatedAt'
>;

class Judgement
  extends Model<IJudgement, JudgementCreationAttributes>
  implements IJudgement
{
  declare id: number;
  declare earlyDouble: number;
  declare earlySingle: number;
  declare ePerfect: number;
  declare perfect: number;
  declare lPerfect: number;
  declare lateSingle: number;
  declare lateDouble: number;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare pass?: Pass;
}

Judgement.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      allowNull: false,
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
    tableName: 'judgements',
  },
);

export default Judgement;
