import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('players');

class KeyboardRig extends Model<
  InferAttributes<KeyboardRig>,
  InferCreationAttributes<KeyboardRig>
> {
  declare id: CreationOptional<number>;
  declare playerId: number;
  declare name: string | null;
  declare sortOrder: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

KeyboardRig.init(
  {
    id: {type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true},
    playerId: {type: DataTypes.INTEGER, allowNull: false},
    name: {type: DataTypes.STRING(80), allowNull: true},
    sortOrder: {type: DataTypes.INTEGER, allowNull: false, defaultValue: 0},
    createdAt: {type: DataTypes.DATE, allowNull: false},
    updatedAt: {type: DataTypes.DATE, allowNull: false},
  },
  {
    sequelize,
    tableName: 'keyboard_rigs',
    indexes: [{fields: ['playerId'], name: 'idx_keyboard_rigs_player_id'}],
  },
);

export default KeyboardRig;
