import { DataTypes, Model, Optional } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('players');

export interface PlayerLeaderboardRankEventAttrs {
  id: number;
  playerId: number;
  scoringVersion: string;
  effectiveDay: string;
  rankedScoreRank: number;
  generalScoreRank: number;
  createdAt: Date;
}

type CreationAttrs = Optional<PlayerLeaderboardRankEventAttrs, 'id' | 'createdAt'>;

class PlayerLeaderboardRankEvent
  extends Model<PlayerLeaderboardRankEventAttrs, CreationAttrs>
  implements PlayerLeaderboardRankEventAttrs
{
  declare id: number;
  declare playerId: number;
  declare scoringVersion: string;
  declare effectiveDay: string;
  declare rankedScoreRank: number;
  declare generalScoreRank: number;
  declare createdAt: Date;
}

PlayerLeaderboardRankEvent.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    playerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'players', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    scoringVersion: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    effectiveDay: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    rankedScoreRank: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    generalScoreRank: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'player_leaderboard_rank_events',
    updatedAt: false,
  },
);

export default PlayerLeaderboardRankEvent;
