import {DataTypes, Model} from 'sequelize';
import sequelize from '../../config/db.js';

interface IReference {
  id?: number;
  difficultyId: number;
  levelId: number;
  type?: string;
  createdAt: Date;
  updatedAt: Date;
}

class Reference extends Model<IReference> implements IReference {
  declare id: number;
  declare difficultyId: number;
  declare levelId: number;
  declare type?: string;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Reference.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    difficultyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'difficulties',
        key: 'id',
      },
    },
    levelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'levels',
        key: 'id',
      },
    },
    type: {
      type: DataTypes.STRING,
      allowNull: true,
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
    tableName: 'references',
    indexes: [
      {
        unique: true,
        fields: ['difficultyId', 'levelId'],
      },
    ],
  },
);

export default Reference;
