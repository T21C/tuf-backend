import {Model, DataTypes, Optional} from 'sequelize';
import Song from './Song.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

type SongAliasAttributes = {
  id: number;
  songId: number;
  alias: string;
  createdAt: Date;
  updatedAt: Date;
};

type SongAliasCreationAttributes = Optional<SongAliasAttributes, 'id' | 'createdAt' | 'updatedAt'>;

class SongAlias extends Model<SongAliasAttributes, SongAliasCreationAttributes> {
  declare id: number;
  declare songId: number;
  declare alias: string;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare song: Song;
}

SongAlias.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    songId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'songs',
        key: 'id',
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    alias: {
      type: DataTypes.STRING(255),
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
    tableName: 'song_aliases',
    indexes: [
      {fields: ['songId']},
      {fields: ['alias']},
    ],
  },
);

export default SongAlias;
