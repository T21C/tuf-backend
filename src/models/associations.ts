import Level from './Level';
import Pass from './Pass';
import Player from './Player';
import Judgement from './Judgement';

export function initializeAssociations() {
  // Pass associations
  Pass.belongsTo(Level, { foreignKey: 'levelId', as: 'level' });
  Pass.belongsTo(Player, { foreignKey: 'playerId', as: 'player' });
  Pass.hasOne(Judgement, { foreignKey: 'passId', as: 'judgements' });

  // Level associations
  Level.hasMany(Pass, { foreignKey: 'levelId', as: 'levelPasses' });

  // Player associations
  Player.hasMany(Pass, { foreignKey: 'playerId', as: 'playerPasses' });
} 