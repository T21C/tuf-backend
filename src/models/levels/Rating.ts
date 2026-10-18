import {Model, DataTypes, Optional} from 'sequelize';
import Level from './Level.js';
import Difficulty from './Difficulty.js';
import RatingDetail from './RatingDetail.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

interface RatingAttributes {
  id: number;
  levelId: number;
  lowDiff: boolean;
  requesterFR: string;
  averageDifficultyId: number | null;
  communityDifficultyId: number | null;
  confirmedAt: Date | null;
  settledDiffId: number | null;
  clearsAtSettle: number | null;
  discordMessageUrl: string | null;
  discordPostError: string | null;
  discordThreadClosed: boolean;
}

type RatingCreationAttributes = Optional<
  RatingAttributes,
  'id' | 'averageDifficultyId' | 'communityDifficultyId' | 'settledDiffId' | 'clearsAtSettle' | 'discordMessageUrl' | 'discordPostError' | 'discordThreadClosed'
>;

class Rating
  extends Model<RatingAttributes, RatingCreationAttributes>
  implements RatingAttributes
{
  declare id: number;
  declare levelId: number;
  declare lowDiff: boolean;
  declare requesterFR: string;
  declare averageDifficultyId: number | null;
  declare communityDifficultyId: number | null;

  // Virtual fields from associations
  declare level?: Level;
  declare details?: RatingDetail[];
  declare averageDifficulty?: Difficulty;
  declare communityDifficulty?: Difficulty;
  declare settledDifficulty?: Difficulty;
  declare confirmedAt: Date | null;
  declare settledDiffId: number | null;
  declare clearsAtSettle: number | null;
  declare discordMessageUrl: string | null;
  declare discordPostError: string | null;
  declare discordThreadClosed: boolean;
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
    settledDiffId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'difficulties',
        key: 'id',
      },
    },
    clearsAtSettle: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    discordMessageUrl: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    discordPostError: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    discordThreadClosed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    sequelize,
    tableName: 'ratings',
    indexes: [{fields: ['levelId']}],
  },
);

export default Rating;
