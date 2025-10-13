import {
    Model,
    DataTypes,
    InferAttributes,
    InferCreationAttributes,
    CreationOptional,
    ForeignKey,
  } from 'sequelize';
  import sequelize from '../../config/db.js';
  import Level from './Level.js';
import User from '../auth/User.js';
import Difficulty from './Difficulty.js';

  class RatingAccuracyVote extends Model<
    InferAttributes<RatingAccuracyVote>,
    InferCreationAttributes<RatingAccuracyVote>
  > {
    declare id: CreationOptional<number>;
    declare levelId: ForeignKey<Level['id']>;
    declare diffId: ForeignKey<Difficulty['id']>;
    declare userId: ForeignKey<User['id']>;
    declare vote: number;
    declare createdAt: CreationOptional<Date>;
    declare updatedAt: CreationOptional<Date>;
  }

  RatingAccuracyVote.init(
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
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
      },
      diffId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'difficulties',
          key: 'id',
        },
      },
      vote: {
        type: DataTypes.INTEGER,
        allowNull: false,
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
      tableName: 'level_rating_accuracy_vote',
      indexes: [
        {
          unique: true,
          fields: ['levelId', 'userId', 'diffId'],
        },
        {
          fields: ['levelId', 'userId'],
        },
      ],
    },
  );

  RatingAccuracyVote.belongsTo(User, {
    foreignKey: 'userId',
    as: 'user',
  });

  export default RatingAccuracyVote;
