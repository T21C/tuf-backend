import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type {KeyboardFormFactor, StoredGeometryKey} from '@/misc/utils/keyboards/types.js';

const sequelize = getSequelizeForModelGroup('players');

class KeyboardGeometry extends Model<
  InferAttributes<KeyboardGeometry>,
  InferCreationAttributes<KeyboardGeometry>
> {
  declare id: CreationOptional<number>;
  declare slug: string;
  declare name: string;
  declare formFactor: KeyboardFormFactor;
  declare keysJson: StoredGeometryKey[];
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

KeyboardGeometry.init(
  {
    id: {type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true},
    slug: {type: DataTypes.STRING(64), allowNull: false, unique: true},
    name: {type: DataTypes.STRING(120), allowNull: false},
    formFactor: {type: DataTypes.STRING(32), allowNull: false},
    keysJson: {type: DataTypes.JSON, allowNull: false},
    createdAt: {type: DataTypes.DATE, allowNull: false},
    updatedAt: {type: DataTypes.DATE, allowNull: false},
  },
  {sequelize, tableName: 'keyboard_geometries'},
);

export default KeyboardGeometry;
