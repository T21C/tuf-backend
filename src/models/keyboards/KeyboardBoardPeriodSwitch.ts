import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('players');

class KeyboardBoardPeriodSwitch extends Model<
  InferAttributes<KeyboardBoardPeriodSwitch>,
  InferCreationAttributes<KeyboardBoardPeriodSwitch>
> {
  declare id: CreationOptional<number>;
  declare boardPeriodId: number;
  declare sortOrder: CreationOptional<number>;
  declare absent: CreationOptional<boolean>;
  declare switchId: number | null;
  declare customSwitch: string | null;
  declare stemColor: string | null;
  declare baseColor: string | null;
  declare topColor: string | null;
  declare baseOpacity: number | null;
}

KeyboardBoardPeriodSwitch.init(
  {
    id: {type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true},
    boardPeriodId: {type: DataTypes.INTEGER, allowNull: false},
    sortOrder: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0},
    absent: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false},
    switchId: {type: DataTypes.INTEGER, allowNull: true},
    customSwitch: {type: DataTypes.STRING(120), allowNull: true},
    stemColor: {type: DataTypes.STRING(7), allowNull: true},
    baseColor: {type: DataTypes.STRING(7), allowNull: true},
    topColor: {type: DataTypes.STRING(7), allowNull: true},
    baseOpacity: {type: DataTypes.DECIMAL(3, 2), allowNull: true},
  },
  {
    sequelize,
    tableName: 'keyboard_board_period_switches',
    timestamps: false,
    indexes: [
      {
        unique: true,
        fields: ['boardPeriodId', 'sortOrder'],
        name: 'uniq_keyboard_board_period_switches_order',
      },
    ],
  },
);

export default KeyboardBoardPeriodSwitch;
