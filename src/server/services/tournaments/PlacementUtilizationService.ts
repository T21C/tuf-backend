import {Op} from 'sequelize';
import TournamentPlacementCredit from '@/models/tournaments/TournamentPlacementCredit.js';
import TournamentPlacement from '@/models/tournaments/TournamentPlacement.js';
import TournamentTier from '@/models/tournaments/TournamentTier.js';
import Tournament from '@/models/tournaments/Tournament.js';
import type {TournamentCardLayout} from '@/models/tournaments/Tournament.js';
import TournamentSeries from '@/models/tournaments/TournamentSeries.js';
import PlacementEntitlement from '@/models/tournaments/PlacementEntitlement.js';
import PlacementReward from '@/models/tournaments/PlacementReward.js';
import EquippedCosmetic from '@/models/tournaments/EquippedCosmetic.js';
import PlacementDisplayNode, {
  type PlacementDisplayMode,
  type PlacementDisplayNodeAttributes,
} from '@/models/tournaments/PlacementDisplayNode.js';
import Player from '@/models/players/Player.js';
import Creator from '@/models/credits/Creator.js';
import {
  UNSERIESED_SORT_WEIGHT,
  resolveEffectiveCardLayout,
  resolveEffectiveRowMode,
} from './placementModeUtils.js';
import type {PlacementRowMode} from '@/models/tournaments/TournamentPlacement.js';

export type PlacementCardLayout = 'default' | 'iconRail';

export function normalizePlacementCardLayout(value: unknown): PlacementCardLayout {
  return value === 'iconRail' ? 'iconRail' : 'default';
}

export function normalizePlacementDisplayMode(value: unknown): PlacementDisplayMode {
  return value === 'customLayers' ? 'customLayers' : 'defaultHierarchy';
}

export interface PlacementSubject {
  playerId?: number | null;
  creatorId?: number | null;
}

export interface PlacementFilters {
  seriesId?: number;
  tournamentId?: number;
  includeHidden?: boolean;
  includePending?: boolean;
  includeProfileHidden?: boolean;
}

export interface PublicPlacementDto {
  id: number;
  creditId: number;
  placementId: number;
  levelId: number | null;
  cardLayout: TournamentCardLayout;
  packRef: string | null;
  coCreditCount: number;
  effectiveRowMode: PlacementRowMode;
  displayName: string;
  withdrew: boolean;
  isPending: boolean;
  teamKey: string | null;
  teamName: string | null;
  positionInTier: number;
  tier: {
    id: number;
    code: string;
    label: string;
    kind: string;
    rankWeight: number;
    color: string | null;
    iconKey: string | null;
    iconUrl: string | null;
    cardBackgroundUrl: string | null;
  };
  tournament: {
    id: number;
    shortName: string;
    fullName: string | null;
    aka: string | null;
    status: string;
    isResultsFinal: boolean;
    sortYear: number | null;
    youtubeUrl: string | null;
    iconUrl: string | null;
    cardBackgroundUrl: string | null;
    series: {id: number; slug: string; name: string; logoUrl: string | null} | null;
  };
  resolvedCardBackgroundUrl: string | null;
  resolvedTournamentIconUrl: string | null;
  isProfileHidden: boolean;
}

export interface PublicEntitlementDto {
  id: number;
  rewardType: string;
  label: string;
  assetUrl: string | null;
  assetId: string | null;
  config: Record<string, unknown> | null;
  priority: number;
  placementId: number;
  grantedAt: Date;
}

export interface PublicEquippedCosmeticDto {
  rewardType: string;
  entitlementId: number | null;
  frame: {
    url: string | null;
    config: Record<string, unknown> | null;
    label: string;
  } | null;
}

export interface PlacementDisplayPrefs {
  placementCardLayout: PlacementCardLayout;
  placementDisplayMode: PlacementDisplayMode;
  hiddenPlacementIds: number[];
  placementOrderIds: number[];
  placementDisplayNodes?: PlacementDisplayNode[];
}

export interface LevelTournamentAppearanceDto {
  placementId: number;
  tier: {
    code: string;
    label: string;
    iconUrl: string | null;
  };
  tournament: {
    id: number;
    shortName: string;
    fullName: string | null;
    sortYear: number | null;
    packRef: string | null;
    iconUrl: string | null;
    externalUrl: string | null;
    youtubeUrl: string | null;
    series: {name: string; logoUrl: string | null} | null;
  };
}

type SortableLevelAppearance = LevelTournamentAppearanceDto & {
  _seriesSortWeight: number;
  _tournamentSortWeight: number;
  _tierRankWeight: number;
};

function toLevelAppearanceDto(placement: TournamentPlacement): LevelTournamentAppearanceDto {
  const tier = (placement as any).tier as TournamentTier;
  const tournament = (placement as any).tournament as Tournament & {
    series?: TournamentSeries | null;
  };
  const series = tournament.series as TournamentSeries | null | undefined;
  const tournamentIcon = tournament.iconUrl ?? series?.logoUrl ?? null;

  return {
    placementId: placement.id,
    tier: {
      code: tier.code,
      label: tier.label,
      iconUrl: tier.iconUrl ?? null,
    },
    tournament: {
      id: tournament.id,
      shortName: tournament.shortName,
      fullName: tournament.fullName,
      sortYear: tournament.sortYear,
      packRef: tournament.packRef,
      iconUrl: tournamentIcon,
      externalUrl: tournament.externalUrl,
      youtubeUrl: tournament.youtubeUrl,
      series: series
        ? {
            name: series.name,
            logoUrl: series.logoUrl ?? null,
          }
        : null,
    },
  };
}

function sortLevelAppearancesDefault(a: SortableLevelAppearance, b: SortableLevelAppearance): number {
  if (a._seriesSortWeight !== b._seriesSortWeight) {
    return a._seriesSortWeight - b._seriesSortWeight;
  }
  if (a._tournamentSortWeight !== b._tournamentSortWeight) {
    return a._tournamentSortWeight - b._tournamentSortWeight;
  }
  if (a._tierRankWeight !== b._tierRankWeight) {
    return a._tierRankWeight - b._tierRankWeight;
  }
  const yearA = a.tournament.sortYear ?? 0;
  const yearB = b.tournament.sortYear ?? 0;
  if (yearA !== yearB) return yearB - yearA;
  return b.placementId - a.placementId;
}

function normalizeIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter(n => Number.isFinite(n)))];
}

const creditInclude = [
  {
    model: TournamentPlacement,
    as: 'placement',
    required: true,
    include: [
      {
        model: TournamentTier,
        as: 'tier',
        required: true,
      },
      {
        model: Tournament,
        as: 'tournament',
        required: true,
        include: [{model: TournamentSeries, as: 'series', required: false}],
      },
    ],
  },
];

function getSeriesSortWeight(
  series: TournamentSeries | null | undefined,
): number {
  return series?.sortWeight ?? UNSERIESED_SORT_WEIGHT;
}

function toPlacementDto(
  credit: TournamentPlacementCredit,
  hiddenIds: Set<number>,
  coCreditCount: number,
): PublicPlacementDto {
  const placement = (credit as any).placement as TournamentPlacement;
  const tier = (placement as any).tier as TournamentTier;
  const tournament = (placement as any).tournament as Tournament & {
    series?: TournamentSeries | null;
  };
  const series = tournament.series as TournamentSeries | null | undefined;
  const tierCardBg = tier.cardBackgroundUrl ?? null;
  const tournamentCardBg = tournament.cardBackgroundUrl ?? null;
  const tournamentIcon = tournament.iconUrl ?? series?.logoUrl ?? null;
  const effectiveRowMode = resolveEffectiveRowMode(
    placement.rowMode,
    tournament.placementMode,
  );
  const hasLevelEvidence = placement.levelId != null;
  const cardLayout = resolveEffectiveCardLayout(
    null,
    tournament,
    null,
    effectiveRowMode,
    hasLevelEvidence,
  );

  return {
    id: credit.id,
    creditId: credit.id,
    placementId: placement.id,
    levelId: placement.levelId,
    cardLayout,
    packRef: tournament.packRef,
    coCreditCount,
    effectiveRowMode,
    displayName: placement.displayName,
    withdrew: placement.withdrew,
    isPending: placement.isPending,
    teamKey: placement.teamKey,
    teamName: placement.teamName,
    positionInTier: placement.positionInTier,
    tier: {
      id: tier.id,
      code: tier.code,
      label: tier.label,
      kind: tier.kind,
      rankWeight: tier.rankWeight,
      color: tier.color,
      iconKey: tier.iconKey,
      iconUrl: tier.iconUrl ?? null,
      cardBackgroundUrl: tierCardBg,
    },
    tournament: {
      id: tournament.id,
      shortName: tournament.shortName,
      fullName: tournament.fullName,
      aka: tournament.aka,
      status: tournament.status,
      isResultsFinal: tournament.isResultsFinal,
      sortYear: tournament.sortYear,
      youtubeUrl: tournament.youtubeUrl,
      iconUrl: tournament.iconUrl ?? null,
      cardBackgroundUrl: tournamentCardBg,
      series: series
        ? {
            id: series.id,
            slug: series.slug,
            name: series.name,
            logoUrl: series.logoUrl ?? null,
          }
        : null,
    },
    resolvedCardBackgroundUrl: tierCardBg ?? tournamentCardBg ?? null,
    resolvedTournamentIconUrl: tournamentIcon,
    isProfileHidden: hiddenIds.has(credit.id),
  };
}

type SortablePlacementDto = PublicPlacementDto & {
  _seriesSortWeight?: number;
  _tournamentSortWeight?: number;
};

function sortPlacementsDefault(a: SortablePlacementDto, b: SortablePlacementDto): number {
  const seriesWeightA = a._seriesSortWeight ?? UNSERIESED_SORT_WEIGHT;
  const seriesWeightB = b._seriesSortWeight ?? UNSERIESED_SORT_WEIGHT;
  if (seriesWeightA !== seriesWeightB) return seriesWeightA - seriesWeightB;

  const tournamentWeightA = a._tournamentSortWeight ?? 0;
  const tournamentWeightB = b._tournamentSortWeight ?? 0;
  if (tournamentWeightA !== tournamentWeightB) {
    return tournamentWeightA - tournamentWeightB;
  }

  if (a.tier.rankWeight !== b.tier.rankWeight) {
    return a.tier.rankWeight - b.tier.rankWeight;
  }

  const yearA = a.tournament.sortYear ?? 0;
  const yearB = b.tournament.sortYear ?? 0;
  if (yearA !== yearB) return yearB - yearA;

  return b.id - a.id;
}

function createPlacementSorter(orderIds: number[]) {
  const orderMap = new Map(orderIds.map((id, index) => [id, index]));
  return (a: SortablePlacementDto, b: SortablePlacementDto) => {
    const aOrder = orderMap.get(a.id);
    const bOrder = orderMap.get(b.id);
    if (aOrder != null && bOrder != null) return aOrder - bOrder;
    if (aOrder != null) return -1;
    if (bOrder != null) return 1;
    return sortPlacementsDefault(a, b);
  };
}

function buildCoCreditCounts(
  credits: TournamentPlacementCredit[],
): Map<number, number> {
  const totals = new Map<number, number>();
  for (const credit of credits) {
    totals.set(credit.placementId, (totals.get(credit.placementId) ?? 0) + 1);
  }
  const others = new Map<number, number>();
  for (const credit of credits) {
    const total = totals.get(credit.placementId) ?? 1;
    others.set(credit.id, Math.max(0, total - 1));
  }
  return others;
}

export class PlacementUtilizationService {
  private static instance: PlacementUtilizationService;

  static getInstance(): PlacementUtilizationService {
    if (!this.instance) this.instance = new PlacementUtilizationService();
    return this.instance;
  }

  async getHiddenPlacementIds(subject: PlacementSubject): Promise<number[]> {
    if (subject.playerId) {
      const player = await Player.findByPk(subject.playerId, {
        attributes: ['hiddenPlacementIds'],
      });
      return normalizeIdList(player?.hiddenPlacementIds);
    }
    if (subject.creatorId) {
      const creator = await Creator.findByPk(subject.creatorId, {
        attributes: ['hiddenPlacementIds'],
      });
      return normalizeIdList(creator?.hiddenPlacementIds);
    }
    return [];
  }

  async getPlacementOrderIds(subject: PlacementSubject): Promise<number[]> {
    if (subject.playerId) {
      const player = await Player.findByPk(subject.playerId, {
        attributes: ['placementOrderIds'],
      });
      return normalizeIdList(player?.placementOrderIds);
    }
    if (subject.creatorId) {
      const creator = await Creator.findByPk(subject.creatorId, {
        attributes: ['placementOrderIds'],
      });
      return normalizeIdList(creator?.placementOrderIds);
    }
    return [];
  }

  async getPlacementDisplayMode(subject: PlacementSubject): Promise<PlacementDisplayMode> {
    if (subject.playerId) {
      const row = await Player.findByPk(subject.playerId, {
        attributes: ['placementDisplayMode'],
      });
      return normalizePlacementDisplayMode(row?.placementDisplayMode);
    }
    if (subject.creatorId) {
      const row = await Creator.findByPk(subject.creatorId, {
        attributes: ['placementDisplayMode'],
      });
      return normalizePlacementDisplayMode(row?.placementDisplayMode);
    }
    return 'defaultHierarchy';
  }

  async setPlacementDisplayMode(
    subject: PlacementSubject,
    mode: unknown,
  ): Promise<PlacementDisplayMode> {
    const placementDisplayMode = normalizePlacementDisplayMode(mode);
    if (subject.playerId) {
      await Player.update({placementDisplayMode}, {where: {id: subject.playerId}});
    } else if (subject.creatorId) {
      await Creator.update({placementDisplayMode}, {where: {id: subject.creatorId}});
    }
    return placementDisplayMode;
  }

  async getPlacementsForPlayer(
    playerId: number,
    filters: PlacementFilters = {},
  ): Promise<PublicPlacementDto[]> {
    return this.getPlacements({playerId}, filters);
  }

  async getPlacementsForCreator(
    creatorId: number,
    filters: PlacementFilters = {},
  ): Promise<PublicPlacementDto[]> {
    return this.getPlacements({creatorId}, filters);
  }

  async getAppearancesForLevel(levelId: number): Promise<LevelTournamentAppearanceDto[]> {
    const placements = await TournamentPlacement.findAll({
      where: {
        levelId,
        withdrew: false,
        isPending: false,
      },
      include: [
        {
          model: TournamentTier,
          as: 'tier',
          required: true,
        },
        {
          model: Tournament,
          as: 'tournament',
          required: true,
          where: {
            isHidden: false,
            status: {[Op.ne]: 'draft'},
          },
          include: [{model: TournamentSeries, as: 'series', required: false}],
        },
      ],
    });

    const sortable: SortableLevelAppearance[] = placements.map(placement => {
      const dto = toLevelAppearanceDto(placement);
      const tournament = (placement as any).tournament as Tournament & {
        series?: TournamentSeries | null;
      };
      const tier = (placement as any).tier as TournamentTier;
      return {
        ...dto,
        _seriesSortWeight: getSeriesSortWeight(tournament.series),
        _tournamentSortWeight: tournament.sortWeight ?? 0,
        _tierRankWeight: tier.rankWeight ?? 0,
      };
    });

    sortable.sort(sortLevelAppearancesDefault);

    return sortable.map(({placementId, tier, tournament}) => ({
      placementId,
      tier,
      tournament,
    }));
  }

  async getPlacements(
    subject: PlacementSubject,
    filters: PlacementFilters = {},
  ): Promise<PublicPlacementDto[]> {
    const creditWhere: Record<string, unknown> = {};
    if (subject.playerId) creditWhere.playerId = subject.playerId;
    else if (subject.creatorId) creditWhere.creatorId = subject.creatorId;
    else return [];

    const placementWhere: Record<string, unknown> = {
      withdrew: false,
    };
    if (!filters.includePending) {
      placementWhere.isPending = false;
    }

    const tournamentWhere: Record<string, unknown> = {};
    if (!filters.includeHidden) {
      tournamentWhere.isHidden = false;
      tournamentWhere.status = {[Op.ne]: 'draft'};
    }
    if (filters.seriesId) tournamentWhere.seriesId = filters.seriesId;
    if (filters.tournamentId) tournamentWhere.id = filters.tournamentId;

    const [hiddenIdsList, orderIds] = await Promise.all([
      this.getHiddenPlacementIds(subject),
      this.getPlacementOrderIds(subject),
    ]);
    const hiddenIds = new Set(hiddenIdsList);

    const rows = await TournamentPlacementCredit.findAll({
      where: creditWhere,
      include: [
        {
          model: TournamentPlacement,
          as: 'placement',
          required: true,
          where: placementWhere,
          include: [
            {
              model: TournamentTier,
              as: 'tier',
              required: true,
            },
            {
              model: Tournament,
              as: 'tournament',
              required: true,
              where: Object.keys(tournamentWhere).length ? tournamentWhere : undefined,
              include: [{model: TournamentSeries, as: 'series', required: false}],
            },
          ],
        },
      ],
    });

    const coCreditCounts = buildCoCreditCounts(rows);

    let dtos: SortablePlacementDto[] = rows.map(credit => {
      const dto = toPlacementDto(
        credit,
        hiddenIds,
        coCreditCounts.get(credit.id) ?? 0,
      ) as SortablePlacementDto;
      const tournament = ((credit as any).placement as TournamentPlacement & {
        tournament?: Tournament;
      }).tournament;
      dto._tournamentSortWeight = tournament?.sortWeight ?? 0;
      dto._seriesSortWeight = getSeriesSortWeight(
        (tournament as Tournament & {series?: TournamentSeries | null})?.series,
      );
      return dto;
    });

    if (!filters.includeProfileHidden) {
      dtos = dtos.filter(d => !d.isProfileHidden);
    }

    const sorter =
      orderIds.length > 0 ? createPlacementSorter(orderIds) : sortPlacementsDefault;
    dtos.sort(sorter);

    return dtos.map(d => {
      const {_tournamentSortWeight, _seriesSortWeight, ...rest} = d as PublicPlacementDto & {
        _tournamentSortWeight?: number;
        _seriesSortWeight?: number;
      };
      return rest;
    });
  }

  async getBestPlacement(
    subject: PlacementSubject,
    filters: PlacementFilters = {},
  ): Promise<PublicPlacementDto | null> {
    const placements = await this.getPlacements(subject, filters);
    return placements[0] ?? null;
  }

  async hasPlacement(
    subject: PlacementSubject,
    options: {
      tournamentId?: number;
      tierCodes?: string[];
      maxRankWeight?: number;
      includeHidden?: boolean;
    } = {},
  ): Promise<boolean> {
    const placements = await this.getPlacements(subject, {
      tournamentId: options.tournamentId,
      includeHidden: options.includeHidden,
    });
    return placements.some(p => {
      if (options.tierCodes?.length && !options.tierCodes.includes(p.tier.code)) {
        return false;
      }
      if (
        options.maxRankWeight != null &&
        p.tier.rankWeight > options.maxRankWeight
      ) {
        return false;
      }
      return true;
    });
  }

  async listEntitlements(
    subject: PlacementSubject,
    options: {rewardType?: string} = {},
  ): Promise<PublicEntitlementDto[]> {
    const where: Record<string, unknown> = {};
    if (subject.playerId) where.playerId = subject.playerId;
    else if (subject.creatorId) where.creatorId = subject.creatorId;
    else return [];

    const rewardWhere: Record<string, unknown> = {};
    if (options.rewardType) rewardWhere.rewardType = options.rewardType;

    const rows = await PlacementEntitlement.findAll({
      where,
      include: [
        {
          model: PlacementReward,
          as: 'reward',
          required: true,
          where: Object.keys(rewardWhere).length ? rewardWhere : undefined,
        },
      ],
      order: [[{model: PlacementReward, as: 'reward'}, 'priority', 'DESC']],
    });

    return rows.map(row => {
      const reward = (row as any).reward as PlacementReward;
      return {
        id: row.id,
        rewardType: reward.rewardType,
        label: reward.label,
        assetUrl: reward.assetUrl,
        assetId: reward.assetId,
        config: reward.config,
        priority: reward.priority,
        placementId: row.placementId,
        grantedAt: row.grantedAt,
      };
    });
  }

  async getEquippedCosmetic(
    subject: PlacementSubject,
    rewardType = 'avatar_frame',
  ): Promise<PublicEquippedCosmeticDto | null> {
    const where: Record<string, unknown> = {rewardType};
    if (subject.playerId) where.playerId = subject.playerId;
    else if (subject.creatorId) where.creatorId = subject.creatorId;
    else return null;

    const equipped = await EquippedCosmetic.findOne({
      where,
      include: [
        {
          model: PlacementEntitlement,
          as: 'entitlement',
          required: false,
          include: [{model: PlacementReward, as: 'reward', required: false}],
        },
      ],
    });

    if (!equipped) {
      return {rewardType, entitlementId: null, frame: null};
    }

    const entitlement = (equipped as any).entitlement as
      | (PlacementEntitlement & {reward?: PlacementReward})
      | null;
    const reward = entitlement?.reward;

    return {
      rewardType,
      entitlementId: equipped.entitlementId,
      frame: reward
        ? {
            url: reward.assetUrl,
            config: reward.config,
            label: reward.label,
          }
        : null,
    };
  }

  async equipCosmetic(
    subject: PlacementSubject,
    rewardType: string,
    entitlementId: number | null,
  ): Promise<PublicEquippedCosmeticDto> {
    if (entitlementId != null) {
      const entitlement = await PlacementEntitlement.findByPk(entitlementId, {
        include: [{model: PlacementReward, as: 'reward', required: true}],
      });
      if (!entitlement) {
        throw Object.assign(new Error('Entitlement not found'), {code: 404});
      }
      const reward = (entitlement as any).reward as PlacementReward;
      if (reward.rewardType !== rewardType) {
        throw Object.assign(new Error('Reward type mismatch'), {code: 400});
      }
      if (subject.playerId && entitlement.playerId !== subject.playerId) {
        throw Object.assign(new Error('Entitlement not owned'), {code: 403});
      }
      if (subject.creatorId && entitlement.creatorId !== subject.creatorId) {
        throw Object.assign(new Error('Entitlement not owned'), {code: 403});
      }
    }

    const where: Record<string, unknown> = {rewardType};
    if (subject.playerId) where.playerId = subject.playerId;
    if (subject.creatorId) where.creatorId = subject.creatorId;

    const existing = await EquippedCosmetic.findOne({where});
    if (existing) {
      await existing.update({entitlementId});
    } else {
      await EquippedCosmetic.create({
        playerId: subject.playerId ?? null,
        creatorId: subject.creatorId ?? null,
        rewardType,
        entitlementId,
      });
    }

    const result = await this.getEquippedCosmetic(subject, rewardType);
    return result ?? {rewardType, entitlementId: null, frame: null};
  }

  async setHiddenPlacementIds(
    subject: PlacementSubject,
    placementIds: number[],
  ): Promise<number[]> {
    const owned = await this.getPlacements(subject, {
      includeHidden: true,
      includePending: true,
      includeProfileHidden: true,
    });
    const ownedIds = new Set(owned.map(p => p.id));
    const filtered = normalizeIdList(placementIds).filter(id => ownedIds.has(id));

    if (subject.playerId) {
      await Player.update(
        {hiddenPlacementIds: filtered.length ? filtered : null},
        {where: {id: subject.playerId}},
      );
    } else if (subject.creatorId) {
      await Creator.update(
        {hiddenPlacementIds: filtered.length ? filtered : null},
        {where: {id: subject.creatorId}},
      );
    }

    return filtered;
  }

  async setPlacementOrderIds(
    subject: PlacementSubject,
    placementIds: number[],
  ): Promise<number[]> {
    const owned = await this.getPlacements(subject, {
      includeHidden: true,
      includePending: true,
      includeProfileHidden: true,
    });
    const hiddenSet = new Set(await this.getHiddenPlacementIds(subject));
    const ownedVisibleIds = new Set(
      owned.filter(p => !hiddenSet.has(p.id)).map(p => p.id),
    );
    const unique = normalizeIdList(placementIds);
    const filtered = unique.filter(id => ownedVisibleIds.has(id));
    const missing = [...ownedVisibleIds].filter(id => !filtered.includes(id));
    const finalOrder = [...filtered, ...missing];

    if (subject.playerId) {
      await Player.update(
        {placementOrderIds: finalOrder.length ? finalOrder : null},
        {where: {id: subject.playerId}},
      );
    } else if (subject.creatorId) {
      await Creator.update(
        {placementOrderIds: finalOrder.length ? finalOrder : null},
        {where: {id: subject.creatorId}},
      );
    }

    return finalOrder;
  }

  async getPlacementCardLayout(subject: PlacementSubject): Promise<PlacementCardLayout> {
    if (subject.playerId) {
      const row = await Player.findByPk(subject.playerId, {
        attributes: ['placementCardLayout'],
      });
      return normalizePlacementCardLayout(row?.placementCardLayout);
    }
    if (subject.creatorId) {
      const row = await Creator.findByPk(subject.creatorId, {
        attributes: ['placementCardLayout'],
      });
      return normalizePlacementCardLayout(row?.placementCardLayout);
    }
    return 'default';
  }

  async setPlacementCardLayout(
    subject: PlacementSubject,
    layout: unknown,
  ): Promise<PlacementCardLayout> {
    const result = await this.setPlacementDisplayPrefs(subject, {cardLayout: layout});
    return result.placementCardLayout;
  }

  async setPlacementDisplayPrefs(
    subject: PlacementSubject,
    prefs: {
      cardLayout?: unknown;
      placementDisplayMode?: unknown;
      placementOrderIds?: unknown;
      hiddenPlacementIds?: unknown;
      placementDisplayNodes?: Array<Partial<PlacementDisplayNodeAttributes>>;
    },
  ): Promise<PlacementDisplayPrefs> {
    const updates: Record<string, unknown> = {};
    let placementCardLayout = await this.getPlacementCardLayout(subject);
    let placementDisplayMode = await this.getPlacementDisplayMode(subject);
    let hiddenPlacementIds = await this.getHiddenPlacementIds(subject);
    let placementOrderIds = await this.getPlacementOrderIds(subject);

    if (prefs.cardLayout !== undefined) {
      placementCardLayout = normalizePlacementCardLayout(prefs.cardLayout);
      updates.placementCardLayout = placementCardLayout;
    }

    if (prefs.placementDisplayMode !== undefined) {
      placementDisplayMode = await this.setPlacementDisplayMode(
        subject,
        prefs.placementDisplayMode,
      );
    }

    if (prefs.hiddenPlacementIds !== undefined) {
      hiddenPlacementIds = await this.setHiddenPlacementIds(
        subject,
        normalizeIdList(prefs.hiddenPlacementIds),
      );
    }

    if (prefs.placementOrderIds !== undefined) {
      placementOrderIds = await this.setPlacementOrderIds(
        subject,
        normalizeIdList(prefs.placementOrderIds),
      );
    }

    let placementDisplayNodes: PlacementDisplayNode[] | undefined;
    if (prefs.placementDisplayNodes !== undefined) {
      placementDisplayNodes = await this.saveDisplayTree(
        subject,
        prefs.placementDisplayNodes,
      );
    }

    if (Object.keys(updates).length > 0) {
      if (subject.playerId) {
        await Player.update(updates, {where: {id: subject.playerId}});
      } else if (subject.creatorId) {
        await Creator.update(updates, {where: {id: subject.creatorId}});
      }
    }

    return {
      placementCardLayout,
      placementDisplayMode,
      hiddenPlacementIds,
      placementOrderIds,
      ...(placementDisplayNodes ? {placementDisplayNodes} : {}),
    };
  }

  async getDisplayTree(subject: PlacementSubject): Promise<PlacementDisplayNode[]> {
    const where: Record<string, unknown> = {};
    if (subject.playerId) where.playerId = subject.playerId;
    else if (subject.creatorId) where.creatorId = subject.creatorId;
    else return [];

    return PlacementDisplayNode.findAll({
      where,
      order: [
        ['sortOrder', 'ASC'],
        ['id', 'ASC'],
      ],
    });
  }

  async saveDisplayTree(
    subject: PlacementSubject,
    nodes: Array<Partial<PlacementDisplayNodeAttributes>>,
  ): Promise<PlacementDisplayNode[]> {
    const where: Record<string, unknown> = {};
    if (subject.playerId) where.playerId = subject.playerId;
    else if (subject.creatorId) where.creatorId = subject.creatorId;
    else return [];

    await PlacementDisplayNode.destroy({where});

    if (!nodes.length) return [];

    const created = await PlacementDisplayNode.bulkCreate(
      nodes.map((node, index) => ({
        playerId: subject.playerId ?? null,
        creatorId: subject.creatorId ?? null,
        parentId: node.parentId ?? null,
        sortOrder: node.sortOrder ?? index,
        visible: node.visible !== false,
        nodeType: node.nodeType ?? 'credit',
        refId: node.refId ?? null,
        label: node.label ?? null,
      })),
    );

    return created;
  }
}

export {creditInclude};
