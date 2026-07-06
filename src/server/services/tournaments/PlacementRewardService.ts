import {Op, Transaction} from 'sequelize';
import PlacementReward from '@/models/tournaments/PlacementReward.js';
import PlacementEntitlement from '@/models/tournaments/PlacementEntitlement.js';
import TournamentPlacement from '@/models/tournaments/TournamentPlacement.js';
import TournamentTier from '@/models/tournaments/TournamentTier.js';
import Tournament from '@/models/tournaments/Tournament.js';
import EquippedCosmetic from '@/models/tournaments/EquippedCosmetic.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

function rewardMatchesPlacement(
  reward: PlacementReward,
  placement: TournamentPlacement,
  tier: TournamentTier,
  tournament: Tournament,
): boolean {
  if (reward.requireFinalResults && !tournament.isResultsFinal) return false;
  if (reward.requireNotWithdrew && placement.withdrew) return false;
  if (placement.isPending) return false;
  if (reward.track && reward.track !== tournament.track) return false;

  if (reward.tournamentId != null && reward.tournamentId !== tournament.id) return false;
  if (reward.seriesId != null && reward.seriesId !== tournament.seriesId) return false;
  if (reward.tournamentId == null && reward.seriesId == null) return false;

  if (reward.tierId != null) {
    return reward.tierId === tier.id;
  }
  if (reward.maxRankWeight != null) {
    return tier.rankWeight <= reward.maxRankWeight;
  }
  return false;
}

export class PlacementRewardService {
  private static instance: PlacementRewardService;

  static getInstance(): PlacementRewardService {
    if (!this.instance) this.instance = new PlacementRewardService();
    return this.instance;
  }

  async syncEntitlementsForTournament(
    tournamentId: number,
    transaction?: Transaction,
  ): Promise<{granted: number; revoked: number}> {
    const sequelize = getSequelizeForModelGroup('tournaments');
    const run = async (t: Transaction) => {
      const tournament = await Tournament.findByPk(tournamentId, {transaction: t});
      if (!tournament) return {granted: 0, revoked: 0};

      const placements = await TournamentPlacement.findAll({
        where: {tournamentId},
        include: [{model: TournamentTier, as: 'tier'}],
        transaction: t,
      });

      const rewards = await PlacementReward.findAll({
        where: {
          [Op.or]: [
            {tournamentId},
            ...(tournament.seriesId != null ? [{seriesId: tournament.seriesId}] : []),
          ],
        },
        transaction: t,
      });

      const desired = new Map<string, {
        rewardId: number;
        placementId: number;
        playerId: number | null;
        creatorId: number | null;
      }>();

      for (const placement of placements) {
        const tier = (placement as any).tier as TournamentTier | undefined;
        if (!tier) continue;
        if (!placement.playerId && !placement.creatorId) continue;

        for (const reward of rewards) {
          if (!rewardMatchesPlacement(reward, placement, tier, tournament)) continue;
          const key = `${reward.id}:${placement.id}`;
          desired.set(key, {
            rewardId: reward.id,
            placementId: placement.id,
            playerId: placement.playerId,
            creatorId: placement.creatorId,
          });
        }
      }

      const placementIds = placements.map(p => p.id);
      const existing = placementIds.length
        ? await PlacementEntitlement.findAll({
            where: {placementId: {[Op.in]: placementIds}},
            transaction: t,
          })
        : [];

      const existingKeys = new Map(existing.map(e => [`${e.rewardId}:${e.placementId}`, e]));
      let granted = 0;
      let revoked = 0;

      for (const [key, row] of desired) {
        if (existingKeys.has(key)) {
          existingKeys.delete(key);
          continue;
        }
        await PlacementEntitlement.create(
          {
            rewardId: row.rewardId,
            placementId: row.placementId,
            playerId: row.playerId,
            creatorId: row.creatorId,
            grantedAt: new Date(),
          },
          {transaction: t},
        );
        granted += 1;
      }

      for (const stale of existingKeys.values()) {
        await EquippedCosmetic.update(
          {entitlementId: null},
          {where: {entitlementId: stale.id}, transaction: t},
        );
        await stale.destroy({transaction: t});
        revoked += 1;
      }

      return {granted, revoked};
    };

    if (transaction) return run(transaction);
    return sequelize.transaction(run);
  }

  async syncEntitlementsForReward(rewardId: number): Promise<{granted: number; revoked: number}> {
    const reward = await PlacementReward.findByPk(rewardId);
    if (!reward) return {granted: 0, revoked: 0};

    const tournamentIds = new Set<number>();
    if (reward.tournamentId != null) tournamentIds.add(reward.tournamentId);
    if (reward.seriesId != null) {
      const tournaments = await Tournament.findAll({
        where: {seriesId: reward.seriesId},
        attributes: ['id'],
      });
      for (const t of tournaments) tournamentIds.add(t.id);
    }

    let granted = 0;
    let revoked = 0;
    for (const id of tournamentIds) {
      const result = await this.syncEntitlementsForTournament(id);
      granted += result.granted;
      revoked += result.revoked;
    }
    return {granted, revoked};
  }
}
