import {Model, DataTypes} from 'sequelize';
import sequelize from '../../config/db.js';
import User from './User.js';

export interface UsernameChangeAttributes {
  id?: number;
  userId: string;
  oldUsername: string;
  newUsername: string;
  createdAt?: Date;
  updatedAt: Date;
}

class UsernameChange extends Model<UsernameChangeAttributes> implements UsernameChangeAttributes {
  declare id: number;
  declare userId: string;
  declare oldUsername: string;
  declare newUsername: string;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Virtual fields
  declare user?: User;
}

UsernameChange.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    oldUsername: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    newUsername: {
      type: DataTypes.STRING,
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
    tableName: 'username_changes',
    indexes: [
      {fields: ['userId', 'updatedAt']},
    ],
  },
);

UsernameChange.belongsTo(User, {
  foreignKey: 'userId',
  as: 'user'
});

export default UsernameChange;
