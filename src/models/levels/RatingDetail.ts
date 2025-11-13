import {Model, DataTypes, Optional} from 'sequelize';
import User from '../auth/User.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

interface RatingDetailAttributes {
  id: number;
  ratingId: number;
  userId: string;
  rating: string;
  comment: string;
  isCommunityRating: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  user?: User;
}

type RatingDetailCreationAttributes = Optional<
  RatingDetailAttributes,
  'id' | 'comment'
>;

class RatingDetail
  extends Model<RatingDetailAttributes, RatingDetailCreationAttributes>
  implements RatingDetailAttributes
{
  declare id: number;
  declare ratingId: number;
  declare userId: string;
  declare rating: string;
  declare comment: string;
  declare isCommunityRating: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;
  // Virtual fields
  declare user?: User;
}

RatingDetail.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    ratingId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'ratings',
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
    rating: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    comment: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    isCommunityRating: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    sequelize,
    tableName: 'rating_details',
    indexes: [{fields: ['ratingId', 'userId'], unique: true}],
  },
);

// Add association
RatingDetail.belongsTo(User, {
  foreignKey: 'userId',
  as: 'user',
});

export default RatingDetail;
