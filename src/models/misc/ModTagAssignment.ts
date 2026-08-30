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
import type ModTag from './ModTag.js';

const sequelize = getSequelizeForModelGroup('admin');

class ModTagAssignment extends Model<
  InferAttributes<ModTagAssignment>,
  InferCreationAttributes<ModTagAssignment>
> {
  declare id: CreationOptional<number>;
  declare modId: ForeignKey<Mod['id']>;
  declare tagId: ForeignKey<ModTag['id']>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

ModTagAssignment.init(
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
    tagId: {
      type: DataTypes.INTEGER,
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
    tableName: 'mod_tag_assignments',
    indexes: [
      {unique: true, fields: ['modId', 'tagId'], name: 'mod_tag_assignments_unique'},
      {fields: ['tagId'], name: 'idx_mod_tag_assignments_tag_id'},
    ],
  },
);

export default ModTagAssignment;
