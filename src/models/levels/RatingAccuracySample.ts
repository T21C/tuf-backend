import {Model, DataTypes} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type {RatingAccuracyChart} from '@/misc/utils/data/ratingAccuracy.js';

const sequelize = getSequelizeForModelGroup('levels');

class RatingAccuracySample extends Model {
  declare ratingDetailId: number;
  declare ratingId: number;
  declare userId: string;
  declare isCommunityRating: boolean;
  declare track: 'pgu' | 'special' | 'skip';
  declare scoringMode: 'rank' | 'q' | 'special';
  declare frozenRating: string;
  declare settledDiffId: number | null;
  declare clearsAtSettle: number | null;
  declare score: number | null;
  declare chart: RatingAccuracyChart | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

RatingAccuracySample.init(
  {
    ratingDetailId: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      allowNull: false,
      references: {model: 'rating_details', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    ratingId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {model: 'ratings', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {model: 'users', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    isCommunityRating: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    track: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    scoringMode: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    frozenRating: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    settledDiffId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {model: 'difficulties', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    clearsAtSettle: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    score: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },
    chart: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'rating_accuracy_samples',
    indexes: [
      {fields: ['userId', 'isCommunityRating']},
      {fields: ['ratingId']},
    ],
  },
);

export default RatingAccuracySample;
