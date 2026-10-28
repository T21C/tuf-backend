import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('players');

class KeyboardBoardPeriodKey extends Model<
  InferAttributes<KeyboardBoardPeriodKey>,
  InferCreationAttributes<KeyboardBoardPeriodKey>
> {
  declare id: CreationOptional<number>;
  declare boardPeriodId: number;
  declare keyCode: string;
  declare socketEmpty: CreationOptional<boolean>;
  declare switchId: number | null;
  declare customSwitch: string | null;
  declare periodSwitchId: number | null;
  declare actuationMm: number | null;
  declare rapidTriggerSplit: boolean | null;
  declare rapidTriggerActuationMm: number | null;
  declare rapidTriggerPressMm: number | null;
  declare rapidTriggerReleaseMm: number | null;
}

KeyboardBoardPeriodKey.init(
  {
    id: {type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true},
    boardPeriodId: {type: DataTypes.INTEGER, allowNull: false},
    keyCode: {type: DataTypes.STRING(64), allowNull: false},
    socketEmpty: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false},
    switchId: {type: DataTypes.INTEGER, allowNull: true},
    customSwitch: {type: DataTypes.STRING(120), allowNull: true},
    periodSwitchId: {type: DataTypes.INTEGER, allowNull: true},
    actuationMm: {type: DataTypes.DECIMAL(4, 2), allowNull: true},
    rapidTriggerSplit: {type: DataTypes.BOOLEAN, allowNull: true},
    rapidTriggerActuationMm: {type: DataTypes.DECIMAL(4, 2), allowNull: true},
    rapidTriggerPressMm: {type: DataTypes.DECIMAL(4, 2), allowNull: true},
    rapidTriggerReleaseMm: {type: DataTypes.DECIMAL(4, 2), allowNull: true},
  },
  {
    sequelize,
    tableName: 'keyboard_board_period_keys',
    timestamps: false,
    indexes: [
      {
        unique: true,
        fields: ['boardPeriodId', 'keyCode'],
        name: 'uniq_keyboard_board_period_keys_code',
      },
    ],
  },
);

export default KeyboardBoardPeriodKey;
