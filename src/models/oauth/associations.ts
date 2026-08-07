import User from '@/models/auth/User.js';
import OAuthClient from './OAuthClient.js';
import OAuthGrant from './OAuthGrant.js';
import OAuthAuthorizationCode from './OAuthAuthorizationCode.js';
import OAuthRefreshToken from './OAuthRefreshToken.js';

export function initializeOAuthAsAssociations() {
  User.hasMany(OAuthClient, {
    foreignKey: 'ownerUserId',
    as: 'oauthClients',
  });
  OAuthClient.belongsTo(User, {
    foreignKey: 'ownerUserId',
    as: 'owner',
  });

  User.hasMany(OAuthGrant, {
    foreignKey: 'userId',
    as: 'oauthGrants',
  });
  OAuthGrant.belongsTo(User, {
    foreignKey: 'userId',
    as: 'user',
  });

  OAuthGrant.hasMany(OAuthAuthorizationCode, {
    foreignKey: 'grantId',
    as: 'authorizationCodes',
  });
  OAuthAuthorizationCode.belongsTo(OAuthGrant, {
    foreignKey: 'grantId',
    as: 'grant',
  });

  OAuthGrant.hasMany(OAuthRefreshToken, {
    foreignKey: 'grantId',
    as: 'refreshTokens',
  });
  OAuthRefreshToken.belongsTo(OAuthGrant, {
    foreignKey: 'grantId',
    as: 'grant',
  });
}
