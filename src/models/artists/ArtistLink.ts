import {Model, DataTypes, Optional} from 'sequelize';
import Artist from './Artist.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

type ArtistLinkAttributes = {
  id: number;
  artistId: number;
  link: string;
  createdAt: Date;
  updatedAt: Date;
};

type ArtistLinkCreationAttributes = Optional<ArtistLinkAttributes, 'id' | 'createdAt' | 'updatedAt'>;

class ArtistLink extends Model<ArtistLinkAttributes, ArtistLinkCreationAttributes> {
  declare id: number;
  declare artistId: number;
  declare link: string;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare artist: Artist;
}

ArtistLink.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
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
    tableName: 'artist_links',
    indexes: [
      {fields: ['artistId']},
    ],
  },
);

export default ArtistLink;
