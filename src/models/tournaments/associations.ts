import TournamentSeries from './TournamentSeries.js';
import Tournament from './Tournament.js';
import TournamentTier from './TournamentTier.js';
import TournamentPlacement from './TournamentPlacement.js';
import PlacementReward from './PlacementReward.js';
import PlacementEntitlement from './PlacementEntitlement.js';
import EquippedCosmetic from './EquippedCosmetic.js';
import Player from '@/models/players/Player.js';
import Creator from '@/models/credits/Creator.js';

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
