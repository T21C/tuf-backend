import Player from './Player.js';
import PlayerStats from './PlayerStats.js';
import PlayerModifier from './PlayerModifier.js';
import PlayerLeaderboardRankEvent from './PlayerLeaderboardRankEvent.js';
import Difficulty from '@/models/levels/Difficulty.js';

export function initializePlayersAssociations() {
  // Player <-> PlayerStats associations
  Player.hasOne(PlayerStats, {
    foreignKey: 'id',
    as: 'stats',
  });

  PlayerStats.belongsTo(Player, {
    foreignKey: 'id',
    as: 'player',
  });

  PlayerStats.belongsTo(Difficulty, {
    foreignKey: 'topDiffId',
    as: 'topDiff',
  });

  PlayerStats.belongsTo(Difficulty, {
    foreignKey: 'top12kDiffId',
    as: 'top12kDiff',
  });

  // Player <-> PlayerModifier associations
  PlayerModifier.belongsTo(Player, {
    foreignKey: 'playerId',
    as: 'modifierPlayer'
  });

  Player.hasMany(PlayerLeaderboardRankEvent, {
    foreignKey: 'playerId',
    as: 'leaderboardRankEvents',
  });
  PlayerLeaderboardRankEvent.belongsTo(Player, {
    foreignKey: 'playerId',
    as: 'player',
  });
}
