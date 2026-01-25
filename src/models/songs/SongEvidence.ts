import {Model, DataTypes, Optional} from 'sequelize';
import Song from './Song.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

type SongEvidenceAttributes = {
  id: number;
  songId: number;
  link: string;
  extraInfo: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type SongEvidenceCreationAttributes = Optional<SongEvidenceAttributes, 'id' | 'createdAt' | 'updatedAt' | 'extraInfo'>;

class SongEvidence extends Model<SongEvidenceAttributes, SongEvidenceCreationAttributes> {
  declare id: number;
  declare songId: number;
  declare link: string;
  declare extraInfo: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare song: Song;
}

SongEvidence.init(
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
    extraInfo: {
      type: DataTypes.TEXT,
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
    tableName: 'song_evidences',
    indexes: [
      {fields: ['songId']},
    ],
  },
);

export default SongEvidence;
