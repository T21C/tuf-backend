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
}

KeyboardBoardPeriodKey.init(
  {
    id: {type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true},
    boardPeriodId: {type: DataTypes.INTEGER, allowNull: false},
    keyCode: {type: DataTypes.STRING(64), allowNull: false},
    socketEmpty: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false},
    switchId: {type: DataTypes.INTEGER, allowNull: true},
    customSwitch: {type: DataTypes.STRING(120), allowNull: true},
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
