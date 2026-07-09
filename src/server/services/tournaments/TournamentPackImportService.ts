import {Op} from 'sequelize';
import Tournament from '@/models/tournaments/Tournament.js';
import TournamentTier from '@/models/tournaments/TournamentTier.js';
import TournamentPlacement from '@/models/tournaments/TournamentPlacement.js';
import LevelPack from '@/models/packs/LevelPack.js';
import LevelPackItem from '@/models/packs/LevelPackItem.js';
import Level from '@/models/levels/Level.js';
import {inferTierFromCode} from './tierTemplates.js';
import {PlacementCreditService} from './PlacementCreditService.js';

const NOMINEE_TIER_CODE = 'NOM';

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

async function loadPackLevels(packId: number): Promise<PackImportDiffItem[]> {
  const items = await LevelPackItem.findAll({
    where: {packId, type: 'level', levelId: {[Op.ne]: null}},
    include: [
      {
        model: Level,
        as: 'referencedLevel',
        required: false,
        attributes: ['id', 'song', 'artist'],
      },
    ],
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  });

  return items.map(item => {
    const level = (item as any).referencedLevel as Level | undefined;
    const displayName =
      level?.song ||
      item.name ||
      `Level #${item.levelId}`;
    return {
      levelId: item.levelId!,
      displayName,
    };
  });
}

async function ensureNomineeTier(tournamentId: number): Promise<TournamentTier> {
  let tier = await TournamentTier.findOne({
    where: {tournamentId, code: NOMINEE_TIER_CODE},
  });
  if (tier) return tier;

  const inferred = inferTierFromCode(NOMINEE_TIER_CODE);
  tier = await TournamentTier.create({
    tournamentId,
    code: NOMINEE_TIER_CODE,
    label: inferred.label === NOMINEE_TIER_CODE ? 'Nominee' : inferred.label,
    kind: inferred.kind,
    rankWeight: inferred.rankWeight,
    sortOrder: inferred.sortOrder,
  });
  return tier;
}

function isDiverged(placement: TournamentPlacement): boolean {
  if (placement.creditedCreatorIds != null && placement.creditedCreatorIds.length > 0) {
    return true;
  }
  return false;
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

    const packLevels = await loadPackLevels(pack.id);
    const packLevelIds = new Set(packLevels.map(l => l.levelId));

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

    for (const level of packLevels) {
      if (!byLevelId.has(level.levelId)) {
        adds.push(level);
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
  ): Promise<{created: number; removed: number}> {
    const tournament = await Tournament.findByPk(tournamentId);
    if (!tournament) {
      throw Object.assign(new Error('Tournament not found'), {code: 404});
    }

    const pack = await resolvePackByRef(packRef);
    if (!pack) {
      throw Object.assign(new Error('Pack not found'), {code: 404});
    }

    const diff = await this.computeDiff(tournamentId, packRef);
    const tier = await ensureNomineeTier(tournamentId);
    let created = 0;
    let removed = 0;

    if (options.acceptAdds !== false) {
      for (const add of diff.adds) {
        await TournamentPlacement.create({
          tournamentId,
          tierId: tier.id,
          displayName: add.displayName,
          playerId: null,
          creatorId: null,
          withdrew: false,
          isPending: false,
          rowMode: 'level',
          levelId: add.levelId,
          creditedCreatorIds: null,
          positionInTier: 0,
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

    await tournament.update({packRef: pack.linkCode});

    if (options.syncCredits) {
      await PlacementCreditService.getInstance().applySync(tournamentId);
    }

    return {created, removed};
  }
}
