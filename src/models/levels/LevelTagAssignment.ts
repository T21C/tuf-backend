import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  ForeignKey,
} from 'sequelize';
import Level from './Level.js';
import LevelTag from './LevelTag.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

class LevelTagAssignment extends Model<
  InferAttributes<LevelTagAssignment>,
  InferCreationAttributes<LevelTagAssignment>
> {
  declare id: CreationOptional<number>;
  declare levelId: ForeignKey<Level['id']>;
  declare tagId: ForeignKey<LevelTag['id']>;
  declare pinned: CreationOptional<boolean>;
  declare score: CreationOptional<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

LevelTagAssignment.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    levelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'levels',
        key: 'id',
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    tagId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'level_tags',
        key: 'id',
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    pinned: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Staff pin; community rematerialize will not drop this assignment',
    },
    score: {
      type: DataTypes.DOUBLE,
      allowNull: true,
      comment: 'Wilson lower-bound score from community votes; null for staff/auto tags',
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'level_tag_assignments',
    indexes: [
      {
        unique: true,
        fields: ['levelId', 'tagId'],
        name: 'level_tag_assignments_unique',
      },
      {
        fields: ['levelId'],
      },
      {
        fields: ['tagId'],
      },
    ],
  },
);

export default LevelTagAssignment;
