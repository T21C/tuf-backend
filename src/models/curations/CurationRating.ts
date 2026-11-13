import {Model, DataTypes, Optional} from 'sequelize';
import Level from '@/models/levels/Level.js';
import User from '@/models/auth/User.js';
import CurationRatingDetail from './CurationRatingDetail.js';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('curations');

interface CurationRatingAttributes {
  id: number;
  levelId: number;
  confirmedAt: Date | null;
  settledByUserId: string | null;
  discordMessageUrl: string | null;
  discordPostError: string | null;
  discordThreadClosed: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

type CurationRatingCreationAttributes = Optional<
  CurationRatingAttributes,
  | 'id'
  | 'confirmedAt'
  | 'settledByUserId'
  | 'discordMessageUrl'
  | 'discordPostError'
  | 'discordThreadClosed'
  | 'createdAt'
  | 'updatedAt'
>;

class CurationRating
  extends Model<CurationRatingAttributes, CurationRatingCreationAttributes>
  implements CurationRatingAttributes
{
  declare id: number;
  declare levelId: number;
  declare confirmedAt: Date | null;
  declare settledByUserId: string | null;
  declare discordMessageUrl: string | null;
  declare discordPostError: string | null;
  declare discordThreadClosed: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;

  declare level?: Level;
  declare details?: CurationRatingDetail[];
  declare settledByUser?: User;
}

CurationRating.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    levelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'levels',
        key: 'id',
      },
    },
    confirmedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    settledByUserId: {
      type: DataTypes.UUID,
      allowNull: true,
      defaultValue: null,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    discordMessageUrl: {
      type: DataTypes.STRING(512),
      allowNull: true,
      defaultValue: null,
    },
    discordPostError: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    discordThreadClosed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    sequelize,
    tableName: 'curation_ratings',
    indexes: [{fields: ['levelId']}],
  },
);

export default CurationRating;
