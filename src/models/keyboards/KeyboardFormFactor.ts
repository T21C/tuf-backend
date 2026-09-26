import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('players');

class KeyboardFormFactor extends Model<
  InferAttributes<KeyboardFormFactor>,
  InferCreationAttributes<KeyboardFormFactor>
> {
  declare slug: string;
  declare name: string;
  declare note: string | null;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

KeyboardFormFactor.init(
  {
    slug: {type: DataTypes.STRING(32), allowNull: false, primaryKey: true},
    name: {type: DataTypes.STRING(64), allowNull: false},
    note: {type: DataTypes.STRING(500), allowNull: true},
    sortOrder: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0},
    createdAt: {type: DataTypes.DATE, allowNull: false},
    updatedAt: {type: DataTypes.DATE, allowNull: false},
  },
  {sequelize, tableName: 'keyboard_form_factors'},
);

export default KeyboardFormFactor;
