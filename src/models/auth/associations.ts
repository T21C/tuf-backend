import User from './User.js';
import OAuthProvider from './OAuthProvider.js';
import Player from '../players/Player.js';
import Creator from '../credits/Creator.js';

export function initializeAuthAssociations() {
  // User <-> Player associations
  User.belongsTo(Player, {
    foreignKey: 'playerId',
    as: 'player',
  });

  Player.hasOne(User, {
    foreignKey: 'playerId',
    as: 'user',
  });

  // User <-> OAuthProvider associations
  User.hasMany(OAuthProvider, {
    foreignKey: 'userId',
    as: 'providers',
  });

  OAuthProvider.belongsTo(User, {
    foreignKey: 'userId',
    as: 'oauthUser',
  });
  User.hasOne(Creator, {
  sourceKey: 'creatorId',
    foreignKey: 'id',
    as: 'creator',
  });
  Creator.belongsTo(User, {
    foreignKey: 'id',
    as: 'user',
  });

}
