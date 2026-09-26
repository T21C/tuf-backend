import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type {KeyboardSensing} from '@/misc/utils/keyboards/types.js';

const sequelize = getSequelizeForModelGroup('players');

class KeyboardBoardPeriod extends Model<
  InferAttributes<KeyboardBoardPeriod>,
  InferCreationAttributes<KeyboardBoardPeriod>
> {
  declare id: CreationOptional<number>;
  declare rigId: number;
  declare sinceDate: string | null;
  declare untilDate: string | null;
  declare untilAuto: CreationOptional<boolean>;
  declare isGap: CreationOptional<boolean>;
  declare geometryId: number | null;
  declare productId: number | null;
  declare customBrand: string | null;
  declare customModel: string | null;
  declare sensing: KeyboardSensing | null;
  declare switchId: number | null;
  declare customSwitch: string | null;
  declare actuationMm: number | null;
  declare rapidTriggerSplit: CreationOptional<boolean>;
  declare rapidTriggerActuationMm: number | null;
  declare rapidTriggerPressMm: number | null;
  declare rapidTriggerReleaseMm: number | null;
  declare colorway: string | null;
  declare note: string | null;
  declare stemColor: string | null;
  declare baseColor: string | null;
  declare topColor: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

KeyboardBoardPeriod.init(
  {
    id: {type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true},
    rigId: {type: DataTypes.INTEGER, allowNull: false},
    sinceDate: {type: DataTypes.DATEONLY, allowNull: true},
    untilDate: {type: DataTypes.DATEONLY, allowNull: true},
    untilAuto: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true},
    isGap: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false},
    geometryId: {type: DataTypes.INTEGER, allowNull: true},
    productId: {type: DataTypes.INTEGER, allowNull: true},
    customBrand: {type: DataTypes.STRING(120), allowNull: true},
    customModel: {type: DataTypes.STRING(120), allowNull: true},
    sensing: {
      type: DataTypes.ENUM('mechanical', 'optical', 'hall', 'other'),
      allowNull: true,
    },
    switchId: {type: DataTypes.INTEGER, allowNull: true},
    customSwitch: {type: DataTypes.STRING(120), allowNull: true},
    actuationMm: {type: DataTypes.DECIMAL(4, 2), allowNull: true},
    rapidTriggerSplit: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false},
    rapidTriggerActuationMm: {type: DataTypes.DECIMAL(4, 2), allowNull: true},
    rapidTriggerPressMm: {type: DataTypes.DECIMAL(4, 2), allowNull: true},
    rapidTriggerReleaseMm: {type: DataTypes.DECIMAL(4, 2), allowNull: true},
    colorway: {type: DataTypes.STRING(120), allowNull: true},
    note: {type: DataTypes.STRING(500), allowNull: true},
    stemColor: {type: DataTypes.STRING(7), allowNull: true},
    baseColor: {type: DataTypes.STRING(7), allowNull: true},
    topColor: {type: DataTypes.STRING(7), allowNull: true},
    createdAt: {type: DataTypes.DATE, allowNull: false},
    updatedAt: {type: DataTypes.DATE, allowNull: false},
  },
  {
    sequelize,
    tableName: 'keyboard_board_periods',
    indexes: [{fields: ['rigId', 'sinceDate'], name: 'idx_keyboard_board_periods_rig_since'}],
  },
);

export default KeyboardBoardPeriod;
