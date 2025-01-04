import {Model, DataTypes, Optional} from 'sequelize';
import sequelize from '../config/db';
import Level from './Level';
import Difficulty from './Difficulty';
import RatingDetail from './RatingDetail';

interface RatingAttributes {
  id: number;
  levelId: number;
  currentDifficultyId: number | null;
  lowDiff: boolean;
  requesterFR: string;
  averageDifficultyId: number | null;
}

type RatingCreationAttributes = Optional<RatingAttributes, 'id' | 'averageDifficultyId' | 'currentDifficultyId'>;

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

  // Virtual fields from associations
  declare level?: Level;
  declare details?: RatingDetail[];
  declare currentDifficulty?: Difficulty;
  declare averageDifficulty?: Difficulty;
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
  },
  {
    sequelize,
    tableName: 'ratings',
    indexes: [{fields: ['levelId'], unique: true}],
  },
);

export default Rating;
