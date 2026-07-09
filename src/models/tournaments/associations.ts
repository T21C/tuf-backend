import TournamentSeries from './TournamentSeries.js';
import Tournament from './Tournament.js';
import TournamentTier from './TournamentTier.js';
import TournamentPlacement from './TournamentPlacement.js';
import TournamentPlacementCredit from './TournamentPlacementCredit.js';
import PlacementDisplayNode from './PlacementDisplayNode.js';
import PlacementReward from './PlacementReward.js';
import PlacementEntitlement from './PlacementEntitlement.js';
import EquippedCosmetic from './EquippedCosmetic.js';
import Player from '@/models/players/Player.js';
import Creator from '@/models/credits/Creator.js';
import Level from '@/models/levels/Level.js';

export function initializeTournamentsAssociations() {
  TournamentSeries.hasMany(Tournament, {
    foreignKey: 'seriesId',
    as: 'tournaments',
  });
  Tournament.belongsTo(TournamentSeries, {
    foreignKey: 'seriesId',
    as: 'series',
  });

  Tournament.hasMany(TournamentTier, {
    foreignKey: 'tournamentId',
    as: 'tiers',
    onDelete: 'CASCADE',
  });
  TournamentTier.belongsTo(Tournament, {
    foreignKey: 'tournamentId',
    as: 'tournament',
  });

  Tournament.hasMany(TournamentPlacement, {
    foreignKey: 'tournamentId',
    as: 'placements',
    onDelete: 'CASCADE',
  });
  TournamentPlacement.belongsTo(Tournament, {
    foreignKey: 'tournamentId',
    as: 'tournament',
  });

  TournamentTier.hasMany(TournamentPlacement, {
    foreignKey: 'tierId',
    as: 'placements',
    onDelete: 'CASCADE',
  });
  TournamentPlacement.belongsTo(TournamentTier, {
    foreignKey: 'tierId',
    as: 'tier',
  });

  TournamentPlacement.belongsTo(Player, {
    foreignKey: 'playerId',
    as: 'player',
  });
  Player.hasMany(TournamentPlacement, {
    foreignKey: 'playerId',
    as: 'tournamentPlacements',
  });

  TournamentPlacement.belongsTo(Creator, {
    foreignKey: 'creatorId',
    as: 'creator',
  });
  Creator.hasMany(TournamentPlacement, {
    foreignKey: 'creatorId',
    as: 'tournamentPlacements',
  });

  TournamentPlacement.belongsTo(Level, {
    foreignKey: 'levelId',
    as: 'level',
  });
  Level.hasMany(TournamentPlacement, {
    foreignKey: 'levelId',
    as: 'tournamentPlacements',
  });

  TournamentPlacement.hasMany(TournamentPlacementCredit, {
    foreignKey: 'placementId',
    as: 'credits',
    onDelete: 'CASCADE',
  });
  TournamentPlacementCredit.belongsTo(TournamentPlacement, {
    foreignKey: 'placementId',
    as: 'placement',
  });

  TournamentPlacementCredit.belongsTo(Player, {
    foreignKey: 'playerId',
    as: 'player',
  });
  Player.hasMany(TournamentPlacementCredit, {
    foreignKey: 'playerId',
    as: 'tournamentPlacementCredits',
  });

  TournamentPlacementCredit.belongsTo(Creator, {
    foreignKey: 'creatorId',
    as: 'creator',
  });
  Creator.hasMany(TournamentPlacementCredit, {
    foreignKey: 'creatorId',
    as: 'tournamentPlacementCredits',
  });

  PlacementDisplayNode.belongsTo(Player, {
    foreignKey: 'playerId',
    as: 'player',
  });
  Player.hasMany(PlacementDisplayNode, {
    foreignKey: 'playerId',
    as: 'placementDisplayNodes',
    onDelete: 'CASCADE',
  });

  PlacementDisplayNode.belongsTo(Creator, {
    foreignKey: 'creatorId',
    as: 'creator',
  });
  Creator.hasMany(PlacementDisplayNode, {
    foreignKey: 'creatorId',
    as: 'placementDisplayNodes',
    onDelete: 'CASCADE',
  });

  Tournament.hasMany(PlacementReward, {
    foreignKey: 'tournamentId',
    as: 'rewards',
    onDelete: 'CASCADE',
  });
  PlacementReward.belongsTo(Tournament, {
    foreignKey: 'tournamentId',
    as: 'tournament',
  });

  TournamentSeries.hasMany(PlacementReward, {
    foreignKey: 'seriesId',
    as: 'rewards',
    onDelete: 'CASCADE',
  });
  PlacementReward.belongsTo(TournamentSeries, {
    foreignKey: 'seriesId',
    as: 'series',
  });

  PlacementReward.belongsTo(TournamentTier, {
    foreignKey: 'tierId',
    as: 'tier',
  });

  PlacementReward.hasMany(PlacementEntitlement, {
    foreignKey: 'rewardId',
    as: 'entitlements',
    onDelete: 'CASCADE',
  });
  PlacementEntitlement.belongsTo(PlacementReward, {
    foreignKey: 'rewardId',
    as: 'reward',
  });

  TournamentPlacement.hasMany(PlacementEntitlement, {
    foreignKey: 'placementId',
    as: 'entitlements',
    onDelete: 'CASCADE',
  });
  PlacementEntitlement.belongsTo(TournamentPlacement, {
    foreignKey: 'placementId',
    as: 'placement',
  });

  TournamentPlacementCredit.hasMany(PlacementEntitlement, {
    foreignKey: 'creditId',
    as: 'entitlements',
    onDelete: 'CASCADE',
  });
  PlacementEntitlement.belongsTo(TournamentPlacementCredit, {
    foreignKey: 'creditId',
    as: 'credit',
  });

  PlacementEntitlement.belongsTo(Player, {
    foreignKey: 'playerId',
    as: 'player',
  });
  PlacementEntitlement.belongsTo(Creator, {
    foreignKey: 'creatorId',
    as: 'creator',
  });

  EquippedCosmetic.belongsTo(PlacementEntitlement, {
    foreignKey: 'entitlementId',
    as: 'entitlement',
  });
  PlacementEntitlement.hasMany(EquippedCosmetic, {
    foreignKey: 'entitlementId',
    as: 'equipped',
  });

  EquippedCosmetic.belongsTo(Player, {
    foreignKey: 'playerId',
    as: 'player',
  });
  EquippedCosmetic.belongsTo(Creator, {
    foreignKey: 'creatorId',
    as: 'creator',
  });
}
