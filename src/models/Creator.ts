import {Model, DataTypes} from 'sequelize';
import sequelize from '../config/db.js';
import {ICreator} from '../interfaces/models/index.js';
import User from './User.js';
import LevelCredit from './LevelCredit.js';

class Creator extends Model implements ICreator {
  declare id: number;
  declare name: string;
  declare aliases: string[];
  declare createdAt: Date;
  declare updatedAt: Date;
  declare isVerified: boolean;
  declare userId: number | null;

  declare user: User;
  declare credits?: LevelCredit[];
}

Creator.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    aliases: {
      type: DataTypes.JSON,
      defaultValue: [],
      get() {
        const rawValue = this.getDataValue('aliases');
        return rawValue ? JSON.parse(rawValue) : [];
      },
      set(value: string[]) {
        this.setDataValue('aliases', JSON.stringify(value));
      },
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    isVerified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id',
      },
    },
  },
  {
    sequelize,
    tableName: 'creators',
  },
);

export default Creator;
