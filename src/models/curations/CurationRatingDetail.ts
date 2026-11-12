import {Model, DataTypes, Optional} from 'sequelize';
import User from '@/models/auth/User.js';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('curations');

interface CurationRatingDetailAttributes {
  id: number;
  curationRatingId: number;
  userId: string;
  chartTypeId: number | null;
  vfxTypeId: number | null;
  miscTypeIds: number[];
  comment: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type CurationRatingDetailCreationAttributes = Optional<
  CurationRatingDetailAttributes,
  'id' | 'chartTypeId' | 'vfxTypeId' | 'miscTypeIds' | 'comment' | 'createdAt' | 'updatedAt'
>;

class CurationRatingDetail
  extends Model<CurationRatingDetailAttributes, CurationRatingDetailCreationAttributes>
  implements CurationRatingDetailAttributes
{
  declare id: number;
  declare curationRatingId: number;
  declare userId: string;
  declare chartTypeId: number | null;
  declare vfxTypeId: number | null;
  declare miscTypeIds: number[];
  declare comment: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare user?: User;
}

CurationRatingDetail.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    curationRatingId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'curation_ratings',
        key: 'id',
      },
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    chartTypeId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    vfxTypeId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    miscTypeIds: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },
    comment: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'curation_rating_details',
    indexes: [{fields: ['curationRatingId', 'userId'], unique: true}],
  },
);

CurationRatingDetail.belongsTo(User, {
  foreignKey: 'userId',
  as: 'user',
});

export default CurationRatingDetail;
