import {Model, DataTypes} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('levels');

class RatingAccuracyStats extends Model {
  declare userId: string;
  declare isCommunityRating: boolean;
  declare pguRawMean: number;
  declare pguN: number;
  declare pguShrunkMean: number;
  declare specialRawMean: number;
  declare specialN: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

RatingAccuracyStats.init(
  {
    userId: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      references: {model: 'users', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    isCommunityRating: {
      type: DataTypes.BOOLEAN,
      primaryKey: true,
      allowNull: false,
      defaultValue: false,
    },
    pguRawMean: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 0,
    },
    pguN: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    pguShrunkMean: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 0.5,
    },
    specialRawMean: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 0,
    },
    specialN: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    tableName: 'rating_accuracy_stats',
  },
);

export default RatingAccuracyStats;
