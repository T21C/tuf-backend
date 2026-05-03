import User from './User.js';
import OAuthProvider from './OAuthProvider.js';
import RefreshToken from './RefreshToken.js';
import Player from '@/models/players/Player.js';
import Creator from '@/models/credits/Creator.js';

export function initializeAuthAssociations() {
  // User <-> RefreshToken associations
  User.hasMany(RefreshToken, {
    foreignKey: 'userId',
    as: 'refreshTokens',
  });
  RefreshToken.belongsTo(User, {
    foreignKey: 'userId',
    as: 'user',
  });

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
  // `creators.userId` → `users.id` (not `users.creatorId` / `creators.id`).
  Creator.belongsTo(User, {
    foreignKey: 'userId',
    as: 'user',
  });

}
