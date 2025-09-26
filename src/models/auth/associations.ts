import User from './User.js';
import OAuthProvider from './OAuthProvider.js';
import Player from '../players/Player.js';

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



  // User <-> LevelSubmission associations
  // Note: LevelSubmission is imported in submissions associations
  
  // User <-> LevelPack associations
  // Note: LevelPack is imported in packs associations
  
  // User <-> PackFolder associations
  // Note: PackFolder is imported in packs associations
  
  // User <-> Curation associations
  // Note: Curation is imported in curations associations
}
