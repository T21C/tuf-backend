import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('players');

class KeyboardProduct extends Model<
  InferAttributes<KeyboardProduct>,
  InferCreationAttributes<KeyboardProduct>
> {
  declare id: CreationOptional<number>;
  declare geometryId: number;
  declare brand: string;
  declare model: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

KeyboardProduct.init(
  {
    id: {type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true},
    geometryId: {type: DataTypes.INTEGER, allowNull: false},
    brand: {type: DataTypes.STRING(120), allowNull: false},
    model: {type: DataTypes.STRING(120), allowNull: false},
    createdAt: {type: DataTypes.DATE, allowNull: false},
    updatedAt: {type: DataTypes.DATE, allowNull: false},
  },
  {
    sequelize,
    tableName: 'keyboard_products',
    indexes: [{unique: true, fields: ['brand', 'model'], name: 'uniq_keyboard_products_brand_model'}],
  },
);

export default KeyboardProduct;
