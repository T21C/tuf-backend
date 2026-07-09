import {Op, Transaction} from 'sequelize';
import Tournament from '@/models/tournaments/Tournament.js';
import TournamentPlacement from '@/models/tournaments/TournamentPlacement.js';
import TournamentPlacementCredit from '@/models/tournaments/TournamentPlacementCredit.js';
import LevelCredit, {CreditRole} from '@/models/levels/LevelCredit.js';
import Player from '@/models/players/Player.js';
import Creator from '@/models/credits/Creator.js';
import {getSequelizeForModelGroup} from '@/config/db.js';
import {
  hasExplicitRecipientFilter,
  normalizeCreditRoleFilter,
  normalizeCreditedCreatorIds,
  resolveEffectiveRowMode,
} from './placementModeUtils.js';
import {PlacementRewardService} from './PlacementRewardService.js';

export interface ResolvedRecipient {
  playerId: number | null;
  creatorId: number | null;
  isGuest: boolean;
  sortOrder: number;
}

export interface CreditSyncPreviewRow {
  placementId: number;
  displayName: string;
  toAdd: ResolvedRecipient[];
  toRemove: Array<{creditId: number; creatorId?: number | null; playerId?: number | null}>;
  unchanged: number;
}

export interface CreditSyncPreview {
  rows: CreditSyncPreviewRow[];
  totalAdd: number;
  totalRemove: number;
}

function recipientKey(r: ResolvedRecipient): string {
  if (r.playerId != null) return `p:${r.playerId}`;
  return `c:${r.creatorId}`;
}

export class PlacementCreditService {
  private static instance: PlacementCreditService;

  static getInstance(): PlacementCreditService {
    if (!this.instance) this.instance = new PlacementCreditService();
    return this.instance;
  }

  async resolveRecipientsForPlacement(
    placement: TournamentPlacement,
    tournament: Tournament,
  ): Promise<ResolvedRecipient[]> {
    const effectiveMode = resolveEffectiveRowMode(
      placement.rowMode,
      tournament.placementMode,
    );

    if (effectiveMode === 'profile') {
      if (tournament.track === 'player' && placement.playerId) {
        return [{playerId: placement.playerId, creatorId: null, isGuest: false, sortOrder: 0}];
      }
      if (tournament.track === 'creator' && placement.creatorId) {
        return [{playerId: null, creatorId: placement.creatorId, isGuest: false, sortOrder: 0}];
      }
      return [];
    }

    if (!placement.levelId) return [];

    const filterIds = normalizeCreditedCreatorIds(placement.creditedCreatorIds);
    const roleFilter = normalizeCreditRoleFilter(tournament.creditRoleFilter);

    if (hasExplicitRecipientFilter(filterIds)) {
      const levelCredits = await LevelCredit.findAll({
        where: {levelId: placement.levelId},
        attributes: ['creatorId', 'role'],
      });
      const onLevel = new Set(levelCredits.map(c => c.creatorId));
      return filterIds!.map((creatorId, index) => ({
        playerId: null,
        creatorId,
        isGuest: !onLevel.has(creatorId),
        sortOrder: index,
      }));
    }

    const roles = roleFilter.filter(
      (r): r is CreditRole => r === CreditRole.CHARTER || r === CreditRole.VFXER,
    );
    const credits = await LevelCredit.findAll({
      where: {
        levelId: placement.levelId,
        role: roles.length ? {[Op.in]: roles} : {[Op.in]: [CreditRole.CHARTER, CreditRole.VFXER]},
      },
      order: [
        ['sortOrder', 'ASC'],
        ['creatorId', 'ASC'],
      ],
    });

    const seen = new Set<number>();
    const recipients: ResolvedRecipient[] = [];
    for (const credit of credits) {
      if (seen.has(credit.creatorId)) continue;
      seen.add(credit.creatorId);
      recipients.push({
        playerId: null,
        creatorId: credit.creatorId,
        isGuest: false,
        sortOrder: recipients.length,
      });
    }
    return recipients;
  }

  async ensureProfileCredit(
    placement: TournamentPlacement,
    tournament: Tournament,
    transaction?: Transaction,
  ): Promise<void> {
    const effectiveMode = resolveEffectiveRowMode(
      placement.rowMode,
      tournament.placementMode,
    );
    if (effectiveMode !== 'profile') return;

    const recipients = await this.resolveRecipientsForPlacement(placement, tournament);
    const existing = await TournamentPlacementCredit.findAll({
      where: {placementId: placement.id},
      transaction,
    });

    if (recipients.length !== 1) {
      if (existing.length) {
        const ids = existing.map(c => c.id);
        await this.scrubCreditIdsFromPrefs(ids, transaction);
        await TournamentPlacementCredit.destroy({
          where: {id: {[Op.in]: ids}},
          transaction,
        });
      }
      return;
    }

    const r = recipients[0];
    const primary = existing[0];
    if (primary) {
      await primary.update(
        {
          playerId: r.playerId,
          creatorId: r.creatorId,
          isGuest: r.isGuest,
          sortOrder: 0,
        },
        {transaction},
      );
      if (existing.length > 1) {
        const extraIds = existing.slice(1).map(c => c.id);
        await this.scrubCreditIdsFromPrefs(extraIds, transaction);
        await TournamentPlacementCredit.destroy({
          where: {id: {[Op.in]: extraIds}},
          transaction,
        });
      }
      return;
    }

    await TournamentPlacementCredit.create(
      {
        placementId: placement.id,
        playerId: r.playerId,
        creatorId: r.creatorId,
        isGuest: r.isGuest,
        sortOrder: 0,
      },
      {transaction},
    );
  }

  async previewSync(
    tournamentId: number,
    placementIds?: number[],
  ): Promise<CreditSyncPreview> {
    const tournament = await Tournament.findByPk(tournamentId);
    if (!tournament) return {rows: [], totalAdd: 0, totalRemove: 0};

    const where: Record<string, unknown> = {tournamentId};
    if (placementIds?.length) where.id = {[Op.in]: placementIds};

    const placements = await TournamentPlacement.findAll({where});
    const rows: CreditSyncPreviewRow[] = [];
    let totalAdd = 0;
    let totalRemove = 0;

    for (const placement of placements) {
      const effectiveMode = resolveEffectiveRowMode(
        placement.rowMode,
        tournament.placementMode,
      );
      if (effectiveMode === 'profile') {
        const desired = await this.resolveRecipientsForPlacement(placement, tournament);
        const existing = await TournamentPlacementCredit.findAll({
          where: {placementId: placement.id},
        });
        const desiredKey = desired[0] ? recipientKey(desired[0]) : null;
        const existingKey = existing[0]
          ? recipientKey({
              playerId: existing[0].playerId,
              creatorId: existing[0].creatorId,
              isGuest: existing[0].isGuest,
              sortOrder: existing[0].sortOrder,
            })
          : null;
        const toAdd =
          desiredKey && desiredKey !== existingKey ? desired : [];
        const toRemove =
          existingKey && desiredKey !== existingKey
            ? existing.map(c => ({
                creditId: c.id,
                creatorId: c.creatorId,
                playerId: c.playerId,
              }))
            : [];
        rows.push({
          placementId: placement.id,
          displayName: placement.displayName,
          toAdd,
          toRemove,
          unchanged: desiredKey === existingKey ? existing.length : 0,
        });
        totalAdd += toAdd.length;
        totalRemove += toRemove.length;
        continue;
      }

      const desired = await this.resolveRecipientsForPlacement(placement, tournament);
      const existing = await TournamentPlacementCredit.findAll({
        where: {placementId: placement.id},
      });
      const desiredMap = new Map(desired.map(r => [recipientKey(r), r]));
      const existingMap = new Map(
        existing.map(c => [
          recipientKey({
            playerId: c.playerId,
            creatorId: c.creatorId,
            isGuest: c.isGuest,
            sortOrder: c.sortOrder,
          }),
          c,
        ]),
      );

      const toAdd = desired.filter(r => !existingMap.has(recipientKey(r)));
      const toRemove = existing
        .filter(
          c =>
            !desiredMap.has(
              recipientKey({
                playerId: c.playerId,
                creatorId: c.creatorId,
                isGuest: c.isGuest,
                sortOrder: c.sortOrder,
              }),
            ),
        )
        .map(c => ({
          creditId: c.id,
          creatorId: c.creatorId,
          playerId: c.playerId,
        }));
      const unchanged = existing.length - toRemove.length;

      rows.push({
        placementId: placement.id,
        displayName: placement.displayName,
        toAdd,
        toRemove,
        unchanged,
      });
      totalAdd += toAdd.length;
      totalRemove += toRemove.length;
    }

    return {rows, totalAdd, totalRemove};
  }

  async applySync(
    tournamentId: number,
    placementIds?: number[],
    transaction?: Transaction,
  ): Promise<CreditSyncPreview> {
    const sequelize = getSequelizeForModelGroup('tournaments');
    const run = async (t: Transaction) => {
      const preview = await this.previewSync(tournamentId, placementIds);
      const removeCreditIds: number[] = [];
      for (const row of preview.rows) {
        for (const rem of row.toRemove) {
          removeCreditIds.push(rem.creditId);
        }
      }
      if (removeCreditIds.length) {
        await this.scrubCreditIdsFromPrefs(removeCreditIds, t);
        await TournamentPlacementCredit.destroy({
          where: {id: {[Op.in]: removeCreditIds}},
          transaction: t,
        });
      }

      for (const row of preview.rows) {
        for (const add of row.toAdd) {
          await TournamentPlacementCredit.create(
            {
              placementId: row.placementId,
              playerId: add.playerId,
              creatorId: add.creatorId,
              isGuest: add.isGuest,
              sortOrder: add.sortOrder,
            },
            {transaction: t},
          );
        }
      }

      await PlacementRewardService.getInstance().syncEntitlementsForTournament(
        tournamentId,
        t,
      );
      return preview;
    };

    if (transaction) return run(transaction);
    return sequelize.transaction(run);
  }

  async scrubCreditIdsFromPrefs(
    creditIds: number[],
    transaction?: Transaction,
  ): Promise<void> {
    if (!creditIds.length) return;
    const idSet = new Set(creditIds);

    for (const rows of [
      await Player.findAll({
        attributes: ['id', 'hiddenPlacementIds', 'placementOrderIds'],
        transaction,
      }),
      await Creator.findAll({
        attributes: ['id', 'hiddenPlacementIds', 'placementOrderIds'],
        transaction,
      }),
    ]) {
      for (const row of rows) {
        const hidden = Array.isArray(row.hiddenPlacementIds)
          ? row.hiddenPlacementIds.filter((id: number) => !idSet.has(id))
          : [];
        const order = Array.isArray(row.placementOrderIds)
          ? row.placementOrderIds.filter((id: number) => !idSet.has(id))
          : [];
        const updates: Record<string, unknown> = {};
        if (JSON.stringify(hidden) !== JSON.stringify(row.hiddenPlacementIds ?? [])) {
          updates.hiddenPlacementIds = hidden.length ? hidden : null;
        }
        if (JSON.stringify(order) !== JSON.stringify(row.placementOrderIds ?? [])) {
          updates.placementOrderIds = order.length ? order : null;
        }
        if (Object.keys(updates).length) {
          await row.update(updates, {transaction});
        }
      }
    }
  }
}
