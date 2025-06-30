import {Model, DataTypes} from 'sequelize';
import Creator from './Creator.js';
import sequelize from '../../config/db.js';

export class CreatorAlias extends Model {
  declare id: number;
  declare creatorId: number;
  declare name: string;
  declare createdAt: Date;
  declare updatedAt: Date;
  
  // Associations
  declare creator: Creator;
}

CreatorAlias.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    creatorId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'creators',
        key: 'id',
      },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    sequelize: sequelize,
    tableName: 'creator_aliases',
    timestamps: true,
  }
);
