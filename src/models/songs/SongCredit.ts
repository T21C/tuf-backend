import {Model, DataTypes, Optional} from 'sequelize';
import Song from './Song.js';
import Artist from '../artists/Artist.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

type SongCreditAttributes = {
  id: number;
  songId: number;
  artistId: number;
  role: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type SongCreditCreationAttributes = Optional<SongCreditAttributes, 'id' | 'createdAt' | 'updatedAt'>;

class SongCredit extends Model<SongCreditAttributes, SongCreditCreationAttributes> {
  declare id: number;
  declare songId: number;
  declare artistId: number;
  declare role: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare song: Song;
  declare artist: Artist;
}

SongCredit.init(
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
    artistId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'artists',
        key: 'id',
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    role: {
      type: DataTypes.STRING(50),
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
    tableName: 'song_credits',
    indexes: [
      {fields: ['songId']},
      {fields: ['artistId']},
      {
        unique: true,
        fields: ['songId', 'artistId'],
        name: 'song_credits_songId_artistId_unique',
      },
    ],
  },
);

export default SongCredit;
