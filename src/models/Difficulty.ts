import {Model, DataTypes} from 'sequelize';
import sequelize from '../config/db';
import {IDifficulty} from '../types/models';

class Difficulty extends Model<IDifficulty> implements IDifficulty {
  declare id: number;
  declare name: string;
  declare type: 'PGU' | 'SPECIAL';
  declare icon: string;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare baseScore: number;
  declare legacy: number;
  declare legacy_icon: string | null;
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
    legacy: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    legacy_icon: {
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
