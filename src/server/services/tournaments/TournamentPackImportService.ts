import {Op} from 'sequelize';
import Tournament from '@/models/tournaments/Tournament.js';
import TournamentTier from '@/models/tournaments/TournamentTier.js';
import TournamentPlacement from '@/models/tournaments/TournamentPlacement.js';
import LevelPack from '@/models/packs/LevelPack.js';
import {PlacementCreditService} from './PlacementCreditService.js';
import {
  buildPlacementPlanFromItems,
  loadPackItemsWithLevels,
} from './TournamentPackCreateService.js';
import type {TierTemplateEntry} from './tierTemplates.js';

export interface PackImportDiffItem {
  levelId: number;
  displayName: string;
  placementId?: number;
}

export interface PackImportDiff {
  adds: PackImportDiffItem[];
  removes: Array<{placementId: number; levelId: number; displayName: string}>;
  diverged: Array<{placementId: number; levelId: number; displayName: string; reason: string}>;
}

async function resolvePackByRef(packRef: string): Promise<LevelPack | null> {
  const ref = packRef.trim();
  if (!ref) return null;
  return LevelPack.findOne({
    where: {
      [Op.or]: [{linkCode: ref}, {id: Number.isFinite(Number(ref)) ? Number(ref) : -1}],
    },
  });
}

function isDiverged(placement: TournamentPlacement): boolean {
  if (placement.creditedCreatorIds != null && placement.creditedCreatorIds.length > 0) {
    return true;
  }
  return false;
}

async function ensureTiers(
  tournamentId: number,
  inferredTiers: TierTemplateEntry[],
): Promise<Map<string, TournamentTier>> {
  const tierByCode = new Map<string, TournamentTier>();
  const existing = await TournamentTier.findAll({where: {tournamentId}});
  for (const tier of existing) {
    tierByCode.set(tier.code.toUpperCase(), tier);
  }

  for (const meta of inferredTiers) {
    if (tierByCode.has(meta.code.toUpperCase())) continue;
    const tier = await TournamentTier.create({
      tournamentId,
      code: meta.code,
      label: meta.label,
      kind: meta.kind,
      rankWeight: meta.rankWeight,
      sortOrder: meta.sortOrder,
    });
    tierByCode.set(meta.code.toUpperCase(), tier);
  }

  return tierByCode;
}

export class TournamentPackImportService {
  private static instance: TournamentPackImportService;

  static getInstance(): TournamentPackImportService {
    if (!this.instance) this.instance = new TournamentPackImportService();
    return this.instance;
  }

  async computeDiff(tournamentId: number, packRef: string): Promise<PackImportDiff> {
    const pack = await resolvePackByRef(packRef);
    if (!pack) {
      throw Object.assign(new Error('Pack not found'), {code: 404});
    }

    const items = await loadPackItemsWithLevels(pack.id);
    const {placements: planPlacements} = buildPlacementPlanFromItems(items);
    const packLevelIds = new Set(planPlacements.map(p => p.levelId));

    const placements = await TournamentPlacement.findAll({
      where: {
        tournamentId,
        levelId: {[Op.ne]: null},
      },
    });

    const byLevelId = new Map(placements.map(p => [p.levelId!, p]));
    const adds: PackImportDiffItem[] = [];
    const removes: PackImportDiff['removes'] = [];
    const diverged: PackImportDiff['diverged'] = [];

    for (const planned of planPlacements) {
      if (!byLevelId.has(planned.levelId)) {
        adds.push({
          levelId: planned.levelId,
          displayName: planned.displayName,
        });
      }
    }

    for (const placement of placements) {
      if (!placement.levelId) continue;
      if (!packLevelIds.has(placement.levelId)) {
        removes.push({
          placementId: placement.id,
          levelId: placement.levelId,
          displayName: placement.displayName,
        });
        continue;
      }
      if (isDiverged(placement)) {
        diverged.push({
          placementId: placement.id,
          levelId: placement.levelId,
          displayName: placement.displayName,
          reason: 'manual_recipients',
        });
      }
    }

    return {adds, removes, diverged};
  }

  async applyImport(
    tournamentId: number,
    packRef: string,
    options: {
      acceptAdds?: boolean;
      acceptRemoves?: boolean;
      placementIdsToRemove?: number[];
      syncCredits?: boolean;
    } = {},
  ): Promise<{created: number; removed: number; repositioned: number}> {
    const tournament = await Tournament.findByPk(tournamentId);
    if (!tournament) {
      throw Object.assign(new Error('Tournament not found'), {code: 404});
    }

    const pack = await resolvePackByRef(packRef);
    if (!pack) {
      throw Object.assign(new Error('Pack not found'), {code: 404});
    }

    const items = await loadPackItemsWithLevels(pack.id);
    const {placements: planPlacements, inferredTiers} = buildPlacementPlanFromItems(items);
    const tierByCode = await ensureTiers(tournamentId, inferredTiers);

    const diff = await this.computeDiff(tournamentId, packRef);
    let created = 0;
    let removed = 0;
    let repositioned = 0;

    const planByLevelId = new Map(planPlacements.map(p => [p.levelId, p]));
    const positionCounters = new Map<string, number>();

    if (options.acceptAdds !== false) {
      for (const add of diff.adds) {
        const planned = planByLevelId.get(add.levelId);
        if (!planned) continue;

        const code = planned.tierCode.toUpperCase();
        const tier = tierByCode.get(code);
        if (!tier) continue;

        const positionInTier = (positionCounters.get(code) ?? 0) + 1;
        positionCounters.set(code, positionInTier);

        await TournamentPlacement.create({
          tournamentId,
          tierId: tier.id,
          displayName: planned.displayName,
          playerId: null,
          creatorId: null,
          withdrew: false,
          isPending: false,
          rowMode: 'level',
          levelId: planned.levelId,
          creditedCreatorIds: null,
          positionInTier,
        });
        created += 1;
      }
    }

    const removeIds = options.placementIdsToRemove?.length
      ? options.placementIdsToRemove
      : options.acceptRemoves !== false
        ? diff.removes.map(r => r.placementId)
        : [];

    if (removeIds.length) {
      removed = await TournamentPlacement.destroy({
        where: {
          tournamentId,
          id: {[Op.in]: removeIds},
        },
      });
    }

    const existingPlacements = await TournamentPlacement.findAll({
      where: {
        tournamentId,
        levelId: {[Op.in]: planPlacements.map(p => p.levelId)},
      },
    });
    const existingByLevelId = new Map(
      existingPlacements.map(p => [p.levelId!, p]),
    );

    positionCounters.clear();
    for (const planned of planPlacements) {
      const placement = existingByLevelId.get(planned.levelId);
      if (!placement) continue;

      const code = planned.tierCode.toUpperCase();
      const tier = tierByCode.get(code);
      if (!tier) continue;

      const positionInTier = (positionCounters.get(code) ?? 0) + 1;
      positionCounters.set(code, positionInTier);

      if (placement.tierId !== tier.id || placement.positionInTier !== positionInTier) {
        await placement.update({
          tierId: tier.id,
          positionInTier,
          displayName: planned.displayName,
        });
        repositioned += 1;
      }
    }

    await tournament.update({packRef: pack.linkCode});

    if (options.syncCredits) {
      await PlacementCreditService.getInstance().applySync(tournamentId);
    }

    return {created, removed, repositioned};
  }
}
