import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('players');

class KeyboardLane extends Model<
  InferAttributes<KeyboardLane>,
  InferCreationAttributes<KeyboardLane>
> {
  declare id: CreationOptional<number>;
  declare rigId: number;
  declare keyCount: number;
  declare name: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

KeyboardLane.init(
  {
    id: {type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true},
    rigId: {type: DataTypes.INTEGER, allowNull: false},
    keyCount: {type: DataTypes.INTEGER, allowNull: false},
    name: {type: DataTypes.STRING(32), allowNull: false, defaultValue: ''},
    createdAt: {type: DataTypes.DATE, allowNull: false},
    updatedAt: {type: DataTypes.DATE, allowNull: false},
  },
  {
    sequelize,
    tableName: 'keyboard_lanes',
  },
);

export default KeyboardLane;
