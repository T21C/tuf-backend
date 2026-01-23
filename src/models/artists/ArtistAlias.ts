import {Model, DataTypes, Optional} from 'sequelize';
import Artist from './Artist.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

type ArtistAliasAttributes = {
  id: number;
  artistId: number;
  alias: string;
  createdAt: Date;
  updatedAt: Date;
};

type ArtistAliasCreationAttributes = Optional<ArtistAliasAttributes, 'id' | 'createdAt' | 'updatedAt'>;

class ArtistAlias extends Model<ArtistAliasAttributes, ArtistAliasCreationAttributes> {
  declare id: number;
  declare artistId: number;
  declare alias: string;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare artist: Artist;
}

ArtistAlias.init(
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
    tableName: 'artist_aliases',
    indexes: [
      {fields: ['artistId']},
      {fields: ['alias']},
    ],
  },
);

export default ArtistAlias;
