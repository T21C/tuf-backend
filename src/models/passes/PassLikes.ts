import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  ForeignKey,
} from 'sequelize';
import Pass from './Pass.js';
import User from '@/models/auth/User.js';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('passes');

class PassLikes extends Model<
  InferAttributes<PassLikes>,
  InferCreationAttributes<PassLikes>
> {
  declare id: CreationOptional<number>;
  declare passId: ForeignKey<Pass['id']>;
  declare userId: ForeignKey<User['id']>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

PassLikes.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    passId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'passes',
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
    tableName: 'pass_likes',
    indexes: [
      {
        unique: true,
        fields: ['passId', 'userId'],
      },
    ],
  },
);

export default PassLikes;
