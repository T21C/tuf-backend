import {Model, DataTypes, Optional} from 'sequelize';
import Song from './Song.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

type SongLinkAttributes = {
  id: number;
  songId: number;
  link: string;
  createdAt: Date;
  updatedAt: Date;
};

type SongLinkCreationAttributes = Optional<SongLinkAttributes, 'id' | 'createdAt' | 'updatedAt'>;

class SongLink extends Model<SongLinkAttributes, SongLinkCreationAttributes> {
  declare id: number;
  declare songId: number;
  declare link: string;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare song: Song;
}

SongLink.init(
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
    link: {
      type: DataTypes.TEXT,
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
    tableName: 'song_links',
    indexes: [
      {fields: ['songId']},
      {
        unique: true,
        fields: ['songId', 'link'],
        name: 'song_links_songId_link_unique',
      },
    ],
  },
);

export default SongLink;
