import {Op, Transaction} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import Tournament from '@/models/tournaments/Tournament.js';
import TournamentTier from '@/models/tournaments/TournamentTier.js';
import TournamentPlacement from '@/models/tournaments/TournamentPlacement.js';
import TournamentPlacementCredit from '@/models/tournaments/TournamentPlacementCredit.js';
import PlacementReward from '@/models/tournaments/PlacementReward.js';
import PlacementDisplayNode from '@/models/tournaments/PlacementDisplayNode.js';
import {PlacementCreditService} from '@/server/services/tournaments/PlacementCreditService.js';

export type TournamentDeletionAssetIds = {
  tournamentId: number;
  assetIds: string[];
};

export class TournamentDeletionService {
  private static instance: TournamentDeletionService;

  static getInstance(): TournamentDeletionService {
    if (!TournamentDeletionService.instance) {
      TournamentDeletionService.instance = new TournamentDeletionService();
    }
    return TournamentDeletionService.instance;
  }

  async collectAssetIds(tournamentId: number): Promise<string[]> {
    const tournament = await Tournament.findByPk(tournamentId, {
      attributes: ['id', 'iconAssetId', 'cardBackgroundAssetId'],
    });
    if (!tournament) return [];

    const [tiers, rewards] = await Promise.all([
      TournamentTier.findAll({
        where: {tournamentId},
        attributes: ['iconAssetId', 'cardBackgroundAssetId'],
      }),
      PlacementReward.findAll({
        where: {tournamentId},
        attributes: ['assetId'],
      }),
    ]);

    const assetIds = new Set<string>();
    for (const id of [
      tournament.iconAssetId,
      tournament.cardBackgroundAssetId,
      ...tiers.flatMap(t => [t.iconAssetId, t.cardBackgroundAssetId]),
      ...rewards.map(r => r.assetId),
    ]) {
      if (id) assetIds.add(id);
    }
    return [...assetIds];
  }

  async deleteTournament(tournamentId: number): Promise<TournamentDeletionAssetIds> {
    const sequelize = getSequelizeForModelGroup('tournaments');
    const assetIds = await this.collectAssetIds(tournamentId);

    await sequelize.transaction(async (transaction: Transaction) => {
      const tournament = await Tournament.findByPk(tournamentId, {transaction});
      if (!tournament) {
        throw new Error('Tournament not found');
      }

      const placements = await TournamentPlacement.findAll({
        where: {tournamentId},
        attributes: ['id'],
        transaction,
      });
      const placementIds = placements.map(p => p.id);

      const credits = placementIds.length
        ? await TournamentPlacementCredit.findAll({
            where: {placementId: {[Op.in]: placementIds}},
            attributes: ['id'],
            transaction,
          })
        : [];
      const creditIds = credits.map(c => c.id);

      if (creditIds.length) {
        await PlacementCreditService.getInstance().scrubCreditIdsFromPrefs(
          creditIds,
          transaction,
        );
      }

      const displayNodeWhere: Record<string, unknown>[] = [
        {nodeType: 'tournamentRef', refId: tournamentId},
      ];
      if (creditIds.length) {
        displayNodeWhere.push({
          nodeType: 'credit',
          refId: {[Op.in]: creditIds},
        });
      }
      await PlacementDisplayNode.destroy({
        where: {[Op.or]: displayNodeWhere},
        transaction,
      });

      await tournament.destroy({transaction});
    });

    return {tournamentId, assetIds};
  }
}
