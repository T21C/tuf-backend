import {Model, DataTypes} from 'sequelize';
import sequelize from '../../config/db.js';

class CreatorAlias extends Model {
  declare id: number;
  declare name: string;
  declare creatorId: number;
}

CreatorAlias.init(
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
    creatorId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'creators',
        key: 'id',
      },
    },
  },
  {
    sequelize,
    tableName: 'creator_aliases',
  },
);

export default CreatorAlias;
