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
  createdAt?: Date;
  updatedAt?: Date;
}

type CurationRatingCreationAttributes = Optional<
  CurationRatingAttributes,
  'id' | 'confirmedAt' | 'settledByUserId' | 'createdAt' | 'updatedAt'
>;

class CurationRating
  extends Model<CurationRatingAttributes, CurationRatingCreationAttributes>
  implements CurationRatingAttributes
{
  declare id: number;
  declare levelId: number;
  declare confirmedAt: Date | null;
  declare settledByUserId: string | null;
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
  },
  {
    sequelize,
    tableName: 'curation_ratings',
    indexes: [{fields: ['levelId']}],
  },
);

export default CurationRating;
