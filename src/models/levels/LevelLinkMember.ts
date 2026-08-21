import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  ForeignKey,
} from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
import type Level from './Level.js';
import type LevelLinkGroup from './LevelLinkGroup.js';

const sequelize = getSequelizeForModelGroup('levels');

class LevelLinkMember extends Model<
  InferAttributes<LevelLinkMember>,
  InferCreationAttributes<LevelLinkMember>
> {
  declare id: CreationOptional<number>;
  declare groupId: ForeignKey<LevelLinkGroup['id']>;
  declare levelId: ForeignKey<Level['id']>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare group?: LevelLinkGroup;
  declare level?: Level;
}

LevelLinkMember.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    groupId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'level_link_groups',
        key: 'id',
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
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
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'level_link_members',
    indexes: [
      {
        unique: true,
        fields: ['levelId'],
        name: 'level_link_members_level_id_unique',
      },
      {
        fields: ['groupId'],
        name: 'level_link_members_group_id',
      },
    ],
  },
);

export default LevelLinkMember;
