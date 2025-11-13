import {
    Model,
    DataTypes,
    InferAttributes,
    InferCreationAttributes,
    CreationOptional,
    ForeignKey,
  } from 'sequelize';
import Level from './Level.js';
import User from '../auth/User.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

  class LevelLikes extends Model<
    InferAttributes<LevelLikes>,
    InferCreationAttributes<LevelLikes>
  > {
    declare id: CreationOptional<number>;
    declare levelId: ForeignKey<Level['id']>;
    declare userId: ForeignKey<User['id']>;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
  }

  LevelLikes.init(
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
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      sequelize,
      tableName: 'level_likes',
      indexes: [
        {
          unique: true,
          fields: ['levelId', 'userId'],
        },
      ],
    },
  );

  export default LevelLikes;
