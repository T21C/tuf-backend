import {Model, DataTypes, Optional} from 'sequelize';
import Artist from './Artist.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

type ArtistEvidenceAttributes = {
  id: number;
  artistId: number;
  link: string;
  createdAt: Date;
  updatedAt: Date;
};

type ArtistEvidenceCreationAttributes = Optional<ArtistEvidenceAttributes, 'id' | 'createdAt' | 'updatedAt'>;

class ArtistEvidence extends Model<ArtistEvidenceAttributes, ArtistEvidenceCreationAttributes> {
  declare id: number;
  declare artistId: number;
  declare link: string;
  declare type: 'official' | 'social' | 'music_platform' | 'other';
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare artist: Artist;
}

ArtistEvidence.init(
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
    tableName: 'artist_evidences',
    indexes: [
      {fields: ['artistId']},
    ],
  },
);

export default ArtistEvidence;
