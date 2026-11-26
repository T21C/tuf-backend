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

class LevelCommunityTagVoteBlock extends Model<
  InferAttributes<LevelCommunityTagVoteBlock>,
  InferCreationAttributes<LevelCommunityTagVoteBlock>
> {
  declare id: CreationOptional<number>;
  declare levelId: ForeignKey<Level['id']>;
  declare tagId: ForeignKey<LevelTag['id']>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

LevelCommunityTagVoteBlock.init(
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
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'level_community_tag_vote_blocks',
    indexes: [
      {
        unique: true,
        fields: ['levelId', 'tagId'],
        name: 'level_community_tag_vote_blocks_level_tag_unique',
      },
      {
        fields: ['levelId'],
        name: 'idx_level_community_tag_vote_blocks_level',
      },
      {
        fields: ['tagId'],
        name: 'idx_level_community_tag_vote_blocks_tag',
      },
    ],
  },
);

export default LevelCommunityTagVoteBlock;
