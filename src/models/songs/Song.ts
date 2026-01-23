import {Model, DataTypes, Optional} from 'sequelize';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

type SongAttributes = {
  id: number;
  name: string;
  verificationState: 'unverified' | 'pending' | 'verified';
  createdAt: Date;
  updatedAt: Date;
};

type SongCreationAttributes = Optional<SongAttributes, 'id' | 'createdAt' | 'updatedAt'>;

class Song extends Model<SongAttributes, SongCreationAttributes> {
  declare id: number;
  declare name: string;
  declare verificationState: 'unverified' | 'pending' | 'verified';
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare aliases?: import('./SongAlias.js').default[];
  declare links?: import('./SongLink.js').default[];
  declare evidences?: import('./SongEvidence.js').default[];
  declare credits?: import('./SongCredit.js').default[];
  declare artists?: import('../artists/Artist.js').default[];
  declare levels?: import('../levels/Level.js').default[];
}

Song.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    verificationState: {
      type: DataTypes.ENUM('unverified', 'pending', 'verified'),
      allowNull: false,
      defaultValue: 'unverified',
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
    tableName: 'songs',
    indexes: [
      {fields: ['name']},
      {fields: ['verificationState']},
    ],
  },
);

export default Song;
