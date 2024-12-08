import { DataTypes } from 'sequelize';
import sequelize from '../config/db';
import BaseModel from './BaseModel';

class RatingDetail extends BaseModel {
  public ratingId!: number;
  public username!: string;
  public rating!: string;
  public comment!: string;
}

RatingDetail.init({
  ratingId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'ratings',
      key: 'id'
    }
  },
  username: {
    type: DataTypes.STRING,
    allowNull: false
  },
  rating: {
    type: DataTypes.STRING,
    allowNull: false
  },
  comment: {
    type: DataTypes.TEXT
  }
}, {
  sequelize,
  tableName: 'rating_details',
  indexes: [
    { fields: ['ratingId', 'username'], unique: true }
  ]
});

export default RatingDetail; 
