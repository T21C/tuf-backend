import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  ForeignKey,
} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type Mod from './Mod.js';

const sequelize = getSequelizeForModelGroup('admin');

class ModLike extends Model<InferAttributes<ModLike>, InferCreationAttributes<ModLike>> {
  declare id: CreationOptional<number>;
  declare modId: ForeignKey<Mod['id']>;
  declare userId: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ModLike.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    modId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'mod_likes',
    indexes: [
      {unique: true, fields: ['modId', 'userId'], name: 'mod_likes_mod_user_unique'},
      {fields: ['userId'], name: 'idx_mod_likes_user_id'},
    ],
  },
);

export default ModLike;
