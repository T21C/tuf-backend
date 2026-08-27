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
import User from '@/models/auth/User.js';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('levels');

class LevelTagVote extends Model<
  InferAttributes<LevelTagVote>,
  InferCreationAttributes<LevelTagVote>
> {
  declare id: CreationOptional<number>;
  declare userId: ForeignKey<User['id']>;
  declare levelId: ForeignKey<Level['id']>;
  declare tagId: ForeignKey<LevelTag['id']>;
  declare weight: number;
  /** 1 upvote, -1 downvote */
  declare direction: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

LevelTagVote.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
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
    weight: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    direction: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1,
      comment: '1 upvote, -1 downvote',
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'level_tag_votes',
    indexes: [
      {
        unique: true,
        fields: ['userId', 'levelId', 'tagId'],
        name: 'level_tag_votes_user_level_tag_unique',
      },
      {
        fields: ['levelId', 'tagId'],
        name: 'idx_level_tag_votes_level_tag',
      },
      {
        fields: ['userId', 'levelId'],
        name: 'idx_level_tag_votes_user_level',
      },
    ],
  },
);

export default LevelTagVote;
