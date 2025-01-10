import {
  Model,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  CreationOptional,
  ForeignKey,
} from 'sequelize';
import sequelize from '../config/db';
import Level from './Level';

class LevelAlias extends Model<
  InferAttributes<LevelAlias>,
  InferCreationAttributes<LevelAlias>
> {
  declare id: CreationOptional<number>;
  declare levelId: ForeignKey<Level['id']>;
  declare field: string; // 'song' or 'artist'
  declare originalValue: string;
  declare alias: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

LevelAlias.init(
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
    field: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isIn: [['song', 'artist']],
      },
    },
    originalValue: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    alias: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'level_aliases',
    indexes: [
      {
        unique: true,
        fields: ['field', 'originalValue', 'alias'],
      },
    ],
  },
);

export default LevelAlias; 