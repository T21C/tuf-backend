import {Model, DataTypes, Optional} from 'sequelize';
import sequelize from '../config/db.js';
import Level from './Level.js';
import Difficulty from './Difficulty.js';
import RatingDetail from './RatingDetail.js';

interface RatingAttributes {
  id: number;
  levelId: number;
  currentDifficultyId: number | null;
  lowDiff: boolean;
  requesterFR: string;
  averageDifficultyId: number | null;
  communityDifficultyId: number | null;
  confirmedAt: Date | null;
}

type RatingCreationAttributes = Optional<
  RatingAttributes,
  'id' | 'averageDifficultyId' | 'currentDifficultyId' | 'communityDifficultyId'
>;

class Rating
  extends Model<RatingAttributes, RatingCreationAttributes>
  implements RatingAttributes
{
  declare id: number;
  declare levelId: number;
  declare currentDifficultyId: number | null;
  declare lowDiff: boolean;
  declare requesterFR: string;
  declare averageDifficultyId: number | null;
  declare communityDifficultyId: number | null;

  // Virtual fields from associations
  declare level?: Level;
  declare details?: RatingDetail[];
  declare currentDifficulty?: Difficulty;
  declare averageDifficulty?: Difficulty;
  declare communityDifficulty?: Difficulty;
  declare confirmedAt: Date | null;
}

Rating.init(
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
    currentDifficultyId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'difficulties',
        key: 'id',
      },
    },
    lowDiff: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    requesterFR: {
      type: DataTypes.STRING,
      defaultValue: '',
    },
    averageDifficultyId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'difficulties',
        key: 'id',
      },
    },
    communityDifficultyId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'difficulties',
        key: 'id',
      },
    },
    confirmedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    sequelize,
    tableName: 'ratings',
    indexes: [{fields: ['levelId']}],
  },
);

export default Rating;
