import {Model, DataTypes} from 'sequelize';
import sequelize from '../config/db';
import {IDifficulty} from '../interfaces/models';

class Difficulty extends Model<IDifficulty> implements IDifficulty {
  declare id: number;
  declare name: string;
  declare type: 'PGU' | 'SPECIAL';
  declare icon: string;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare baseScore: number;
  declare sortOrder: number;
  declare legacy: number;
  declare legacyIcon: string | null;
}

Difficulty.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM('PGU', 'SPECIAL'),
      allowNull: false,
    },
    icon: {
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
    baseScore: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    legacy: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    legacyIcon: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'difficulties',
  },
);

export default Difficulty;