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

class ModAssignee extends Model<InferAttributes<ModAssignee>, InferCreationAttributes<ModAssignee>> {
  declare id: CreationOptional<number>;
  declare modId: ForeignKey<Mod['id']>;
  declare userId: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare mod?: Mod;
}

ModAssignee.init(
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
    tableName: 'mod_assignees',
    indexes: [
      {unique: true, fields: ['modId', 'userId'], name: 'mod_assignees_mod_user_unique'},
      {fields: ['userId'], name: 'idx_mod_assignees_user_id'},
    ],
  },
);

export default ModAssignee;
