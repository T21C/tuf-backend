import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type {KeyboardSwitchSensing, KeyboardSwitchStem} from '@/misc/utils/keyboards/types.js';

const sequelize = getSequelizeForModelGroup('players');

class KeyboardSwitch extends Model<
  InferAttributes<KeyboardSwitch>,
  InferCreationAttributes<KeyboardSwitch>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare sensing: KeyboardSwitchSensing | null;
  declare stem: CreationOptional<KeyboardSwitchStem | null>;
  declare baseColor: CreationOptional<string | null>;
  declare topColor: CreationOptional<string | null>;
  declare stemColor: CreationOptional<string | null>;
  declare baseOpacity: CreationOptional<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

KeyboardSwitch.init(
  {
    id: {type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true},
    name: {type: DataTypes.STRING(120), allowNull: false, unique: true},
    sensing: {
      type: DataTypes.ENUM('mechanical', 'optical', 'hall', 'other'),
      allowNull: true,
    },
    stem: {type: DataTypes.STRING(16), allowNull: true},
    baseColor: {type: DataTypes.STRING(7), allowNull: true},
    topColor: {type: DataTypes.STRING(7), allowNull: true},
    stemColor: {type: DataTypes.STRING(7), allowNull: true},
    baseOpacity: {type: DataTypes.DECIMAL(3, 2), allowNull: true},
    createdAt: {type: DataTypes.DATE, allowNull: false},
    updatedAt: {type: DataTypes.DATE, allowNull: false},
  },
  {sequelize, tableName: 'keyboard_switches'},
);

export default KeyboardSwitch;
