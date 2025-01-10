import {DataTypes} from 'sequelize';
import sequelize from '../config/db';
import BaseModel from './BaseModel';
import User from './User';

class RatingDetail extends BaseModel {
  declare ratingId: number;
  declare userId: string;
  declare rating: string;
  declare comment: string;
  
  // Virtual fields
  declare user?: User;
}

RatingDetail.init(
  {
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
  as: 'user'
});

export default RatingDetail;
