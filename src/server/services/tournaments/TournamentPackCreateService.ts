import {Op, Transaction} from 'sequelize';
import Tournament, {type TournamentStatus} from '@/models/tournaments/Tournament.js';
import TournamentTier from '@/models/tournaments/TournamentTier.js';
import TournamentPlacement from '@/models/tournaments/TournamentPlacement.js';
import TournamentSeries from '@/models/tournaments/TournamentSeries.js';
import LevelPack from '@/models/packs/LevelPack.js';
import LevelPackItem from '@/models/packs/LevelPackItem.js';
import Level from '@/models/levels/Level.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import Creator from '@/models/credits/Creator.js';
import {inferTierFromCode, tierMetaFromLabel, type TierTemplateEntry} from './tierTemplates.js';
import {PlacementCreditService} from './PlacementCreditService.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

const NOMINEE_TIER_CODE = 'NOM';

export interface PackCreatePlacementPlanItem {
  levelId: number;
  displayName: string;
  tierCode: string;
}

type LoadedPackItem = LevelPackItem & {
  referencedLevel?: (Level & {levelCredits?: LevelCredit[]}) | null;
};

async function resolvePackByRef(packRef: string): Promise<LevelPack | null> {
  const ref = packRef.trim();
  if (!ref) return null;
  return LevelPack.findOne({
    where: {
      [Op.or]: [{linkCode: ref}, {id: Number.isFinite(Number(ref)) ? Number(ref) : -1}],
    },
  });
}

function tierMetaFromCode(code: string, usedCodes?: Set<string>, sortOrderHint?: number): TierTemplateEntry {
  if (code.toUpperCase() === NOMINEE_TIER_CODE) {
    const inferred = inferTierFromCode(code);
    return {...inferred, label: 'Nominee'};
  }
  return tierMetaFromLabel(code, usedCodes, sortOrderHint);
}

function displayNameForItem(item: LoadedPackItem): string {
  const level = item.referencedLevel;
  return level?.song || item.name || `Level #${item.levelId}`;
}

export async function loadPackItemsWithLevels(packId: number): Promise<LoadedPackItem[]> {
  return LevelPackItem.findAll({
    where: {packId},
    include: [
      {
        model: Level,
        as: 'referencedLevel',
        required: false,
        attributes: ['id', 'song'],
      },
    ],
    order: [
      ['sortOrder', 'ASC'],
      ['id', 'ASC'],
    ],
  }) as Promise<LoadedPackItem[]>;
}

function buildChildrenMap(items: LoadedPackItem[]): Map<number, LoadedPackItem[]> {
  const map = new Map<number, LoadedPackItem[]>();
  for (const item of items) {
    const parentId = item.parentId ?? 0;
    const list = map.get(parentId) ?? [];
    list.push(item);
    map.set(parentId, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  }
  return map;
}

function collectDescendantLevels(
  folderId: number,
  childrenByParent: Map<number, LoadedPackItem[]>,
  seenLevelIds: Set<number>,
): LoadedPackItem[] {
  const children = childrenByParent.get(folderId) ?? [];
  const result: LoadedPackItem[] = [];

  for (const child of children) {
    if (child.type === 'level' && child.levelId != null) {
      if (!seenLevelIds.has(child.levelId)) {
        seenLevelIds.add(child.levelId);
        result.push(child);
      }
      continue;
    }
    if (child.type === 'folder') {
      result.push(...collectDescendantLevels(child.id, childrenByParent, seenLevelIds));
    }
  }

  return result;
}

function toPlacementItem(
  item: LoadedPackItem,
  tierCode: string,
): PackCreatePlacementPlanItem | null {
  if (item.type !== 'level' || item.levelId == null || !item.referencedLevel) {
    return null;
  }
  return {
    levelId: item.levelId,
    displayName: displayNameForItem(item),
    tierCode,
  };
}

export function buildPlacementPlanFromItems(
  items: LoadedPackItem[],
): {placements: PackCreatePlacementPlanItem[]; inferredTiers: TierTemplateEntry[]} {
  const childrenByParent = buildChildrenMap(items);
  const seenLevelIds = new Set<number>();
  const placements: PackCreatePlacementPlanItem[] = [];
  const usedTierCodes = new Set<string>();
  const tierPlans = new Map<string, TierTemplateEntry>();

  const rememberTier = (meta: TierTemplateEntry) => {
    tierPlans.set(meta.code.toUpperCase(), meta);
  };

  const rootFolders = (childrenByParent.get(0) ?? []).filter(i => i.type === 'folder');
  const rootLevels = (childrenByParent.get(0) ?? []).filter(
    i => i.type === 'level' && i.levelId != null,
  );

  if (rootFolders.length === 0) {
    rememberTier(tierMetaFromCode(NOMINEE_TIER_CODE, usedTierCodes));

    const levelItems = items
      .filter(i => i.type === 'level' && i.levelId != null && i.referencedLevel)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);

    for (const item of levelItems) {
      if (seenLevelIds.has(item.levelId!)) continue;
      seenLevelIds.add(item.levelId!);
      const placement = toPlacementItem(item, NOMINEE_TIER_CODE);
      if (placement) placements.push(placement);
    }
  } else {
    rootFolders.forEach((folder, folderIndex) => {
      const meta = tierMetaFromCode(
        folder.name ?? NOMINEE_TIER_CODE,
        usedTierCodes,
        folder.sortOrder ?? folderIndex,
      );
      rememberTier(meta);
      const descendantItems = collectDescendantLevels(folder.id, childrenByParent, seenLevelIds);
      for (const item of descendantItems) {
        const placement = toPlacementItem(item, meta.code);
        if (placement) placements.push(placement);
      }
    });

    if (rootLevels.length) {
      rememberTier(tierMetaFromCode(NOMINEE_TIER_CODE, usedTierCodes));
    }

    for (const item of rootLevels) {
      if (item.levelId == null || seenLevelIds.has(item.levelId)) continue;
      seenLevelIds.add(item.levelId);
      const placement = toPlacementItem(item, NOMINEE_TIER_CODE);
      if (placement) placements.push(placement);
    }
  }

  const inferredTiers = [...tierPlans.values()].sort(
    (a, b) => a.rankWeight - b.rankWeight || a.sortOrder - b.sortOrder,
  );

  return {placements, inferredTiers};
}

export interface PackCreateInput {
  packRef: string;
  shortName?: string | null;
  fullName?: string | null;
  aka?: string | null;
  seriesId?: number | null;
  status?: TournamentStatus;
  isHidden?: boolean;
  isResultsFinal?: boolean;
  youtubeUrl?: string | null;
  notes?: string | null;
  externalUrl?: string | null;
  organizers?: string[] | null;
  sortYear?: number | null;
  syncCredits?: boolean;
}

export class TournamentPackCreateService {
  private static instance: TournamentPackCreateService;

  static getInstance(): TournamentPackCreateService {
    if (!this.instance) this.instance = new TournamentPackCreateService();
    return this.instance;
  }

  async createFromPack(input: PackCreateInput): Promise<Tournament> {
    const pack = await resolvePackByRef(input.packRef);
    if (!pack) {
      throw Object.assign(new Error('Pack not found'), {code: 404});
    }

    const items = await loadPackItemsWithLevels(pack.id);
    const {placements: planPlacements, inferredTiers} = buildPlacementPlanFromItems(items);
    if (!planPlacements.length) {
      throw Object.assign(new Error('Pack has no levels to import'), {code: 400});
    }

    const shortName = String(input.shortName || pack.name || '').trim();
    if (!shortName) {
      throw Object.assign(new Error('shortName is required'), {code: 400});
    }

    const placements = planPlacements.map(p => ({
      levelId: p.levelId,
      displayName: p.displayName,
      tierCode: p.tierCode,
    }));

    const sequelize = getSequelizeForModelGroup('tournaments');
    const creditService = PlacementCreditService.getInstance();
    let tournamentId = 0;

    await sequelize.transaction(async (transaction: Transaction) => {
      const tournament = await Tournament.create(
        {
          shortName,
          fullName: input.fullName ?? null,
          aka: input.aka ?? null,
          seriesId: input.seriesId ?? null,
          status: (input.status ?? 'draft') as TournamentStatus,
          isHidden: Boolean(input.isHidden),
          isResultsFinal: Boolean(input.isResultsFinal),
          youtubeUrl: input.youtubeUrl ?? null,
          packRef: pack.linkCode,
          notes: input.notes ?? null,
          externalUrl: input.externalUrl ?? null,
          organizers: Array.isArray(input.organizers) ? input.organizers : null,
          sortYear: input.sortYear ?? null,
          placementMode: 'level',
        },
        {transaction},
      );
      tournamentId = tournament.id;

      const tierByCode = new Map<string, TournamentTier>();

      for (const meta of inferredTiers) {
        const tier = await TournamentTier.create(
          {
            tournamentId: tournament.id,
            code: meta.code,
            label: meta.label,
            kind: meta.kind,
            rankWeight: meta.rankWeight,
            sortOrder: meta.sortOrder,
          },
          {transaction},
        );
        tierByCode.set(meta.code.toUpperCase(), tier);
      }

      const positionCounters = new Map<string, number>();

      for (const row of placements) {
        const code = String(row.tierCode || '').trim().toUpperCase();
        if (!code || !row.levelId) continue;

        const tier = tierByCode.get(code);
        if (!tier) continue;

        const position = (positionCounters.get(code) ?? 0) + 1;
        positionCounters.set(code, position);

        await TournamentPlacement.create(
          {
            tournamentId: tournament.id,
            tierId: tier.id,
            displayName: String(row.displayName || '').trim() || `Level #${row.levelId}`,
            playerId: null,
            creatorId: null,
            withdrew: false,
            isPending: false,
            rowMode: 'level',
            levelId: row.levelId,
            creditedCreatorIds: null,
            positionInTier: position,
          },
          {transaction},
        );
      }

      if (input.syncCredits !== false) {
        await creditService.applySync(tournament.id, undefined, transaction);
      }
    });

    const full = await Tournament.findByPk(tournamentId, {
      include: [
        {model: TournamentSeries, as: 'series', required: false},
        {
          model: TournamentTier,
          as: 'tiers',
          required: false,
          separate: true,
          order: [
            ['rankWeight', 'ASC'],
            ['sortOrder', 'ASC'],
          ],
        },
        {
          model: TournamentPlacement,
          as: 'placements',
          required: false,
          separate: true,
          include: [
            {model: TournamentTier, as: 'tier'},
            {
              model: Level,
              as: 'level',
              required: false,
              attributes: ['id', 'song', 'artist', 'diffId', 'team'],
              include: [
                {
                  model: LevelCredit,
                  as: 'levelCredits',
                  required: false,
                  include: [
                    {
                      model: Creator,
                      as: 'creator',
                      required: false,
                      attributes: ['id', 'name'],
                    },
                  ],
                },
              ],
            },
          ],
          order: [
            ['positionInTier', 'ASC'],
            ['id', 'ASC'],
          ],
        },
      ],
    });

    if (!full) {
      throw Object.assign(new Error('Failed to load created tournament'), {code: 500});
    }

    return full;
  }
}
