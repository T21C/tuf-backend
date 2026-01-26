import {Model, DataTypes, Optional} from 'sequelize';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

type ArtistRelationAttributes = {
  id: number;
  artistId1: number;
  artistId2: number;
  createdAt: Date;
  updatedAt: Date;
};

type ArtistRelationCreationAttributes = Optional<ArtistRelationAttributes, 'id' | 'createdAt' | 'updatedAt'>;

class ArtistRelation extends Model<ArtistRelationAttributes, ArtistRelationCreationAttributes> {
  declare id: number;
  declare artistId1: number;
  declare artistId2: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

ArtistRelation.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    artistId1: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'artists',
        key: 'id',
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    artistId2: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'artists',
        key: 'id',
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
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
    tableName: 'artist_relations',
    indexes: [
      {fields: ['artistId1']},
      {fields: ['artistId2']},
      {
        unique: true,
        fields: ['artistId1', 'artistId2'],
        name: 'artist_relations_unique_pair',
      },
    ],
  },
);

export default ArtistRelation;
