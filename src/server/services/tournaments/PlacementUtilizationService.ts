import {Op} from 'sequelize';
import TournamentPlacement from '@/models/tournaments/TournamentPlacement.js';
import TournamentTier from '@/models/tournaments/TournamentTier.js';
import Tournament from '@/models/tournaments/Tournament.js';
import TournamentSeries from '@/models/tournaments/TournamentSeries.js';
import PlacementEntitlement from '@/models/tournaments/PlacementEntitlement.js';
import PlacementReward from '@/models/tournaments/PlacementReward.js';
import EquippedCosmetic from '@/models/tournaments/EquippedCosmetic.js';
import Player from '@/models/players/Player.js';
import Creator from '@/models/credits/Creator.js';
import type {TournamentTrack} from '@/models/tournaments/Tournament.js';

export type PlacementCardLayout = 'default' | 'iconRail';

export function normalizePlacementCardLayout(value: unknown): PlacementCardLayout {
  return value === 'iconRail' ? 'iconRail' : 'default';
}

export interface PlacementSubject {
  playerId?: number | null;
  creatorId?: number | null;
}

export interface PlacementFilters {
  track?: TournamentTrack;
  seriesId?: number;
  tournamentId?: number;
  includeHidden?: boolean;
  includePending?: boolean;
  includeProfileHidden?: boolean;
  featuredOnly?: boolean;
}

export interface PublicPlacementDto {
  id: number;
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
    isPodium: boolean;
    isShowcaseEligible: boolean;
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
    track: TournamentTrack;
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
  isFeatured: boolean;
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
  hiddenPlacementIds: number[];
  placementOrderIds: number[];
}

function normalizeIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter(n => Number.isFinite(n)))];
}

const placementInclude = [
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
];

function toPlacementDto(
  row: TournamentPlacement,
  featuredIds: Set<number>,
  hiddenIds: Set<number>,
): PublicPlacementDto {
  const tier = (row as any).tier as TournamentTier;
  const tournament = (row as any).tournament as Tournament & {
    series?: TournamentSeries | null;
  };
  const series = tournament.series as TournamentSeries | null | undefined;
  const tierCardBg = tier.cardBackgroundUrl ?? null;
  const tournamentCardBg = tournament.cardBackgroundUrl ?? null;
  const tournamentIcon =
    tournament.iconUrl ?? series?.logoUrl ?? null;

  return {
    id: row.id,
    displayName: row.displayName,
    withdrew: row.withdrew,
    isPending: row.isPending,
    teamKey: row.teamKey,
    teamName: row.teamName,
    positionInTier: row.positionInTier,
    tier: {
      id: tier.id,
      code: tier.code,
      label: tier.label,
      kind: tier.kind,
      rankWeight: tier.rankWeight,
      isPodium: tier.isPodium,
      isShowcaseEligible: tier.isShowcaseEligible,
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
      track: tournament.track,
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
    isFeatured: featuredIds.has(row.id),
    isProfileHidden: hiddenIds.has(row.id),
  };
}

function sortPlacementsDefault(a: PublicPlacementDto, b: PublicPlacementDto): number {
  if (a.isFeatured !== b.isFeatured) return a.isFeatured ? -1 : 1;
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
  return (a: PublicPlacementDto, b: PublicPlacementDto) => {
    const aOrder = orderMap.get(a.id);
    const bOrder = orderMap.get(b.id);
    if (aOrder != null && bOrder != null) return aOrder - bOrder;
    if (aOrder != null) return -1;
    if (bOrder != null) return 1;
    return sortPlacementsDefault(a, b);
  };
}

export class PlacementUtilizationService {
  private static instance: PlacementUtilizationService;

  static getInstance(): PlacementUtilizationService {
    if (!this.instance) this.instance = new PlacementUtilizationService();
    return this.instance;
  }

  async getFeaturedPlacementIds(subject: PlacementSubject): Promise<number[]> {
    if (subject.playerId) {
      const player = await Player.findByPk(subject.playerId, {
        attributes: ['featuredPlacementIds'],
      });
      return Array.isArray(player?.featuredPlacementIds)
        ? player!.featuredPlacementIds!.filter(n => Number.isFinite(n))
        : [];
    }
    if (subject.creatorId) {
      const creator = await Creator.findByPk(subject.creatorId, {
        attributes: ['featuredPlacementIds'],
      });
      return Array.isArray(creator?.featuredPlacementIds)
        ? creator!.featuredPlacementIds!.filter(n => Number.isFinite(n))
        : [];
    }
    return [];
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

  async getPlacementsForPlayer(
    playerId: number,
    filters: PlacementFilters = {},
  ): Promise<PublicPlacementDto[]> {
    return this.getPlacements({playerId}, {...filters, track: filters.track ?? 'player'});
  }

  async getPlacementsForCreator(
    creatorId: number,
    filters: PlacementFilters = {},
  ): Promise<PublicPlacementDto[]> {
    return this.getPlacements({creatorId}, {...filters, track: filters.track ?? 'creator'});
  }

  async getPlacements(
    subject: PlacementSubject,
    filters: PlacementFilters = {},
  ): Promise<PublicPlacementDto[]> {
    const where: Record<string, unknown> = {};
    if (subject.playerId) where.playerId = subject.playerId;
    else if (subject.creatorId) where.creatorId = subject.creatorId;
    else return [];

    if (!filters.includePending) {
      where.isPending = false;
    }

    const tournamentWhere: Record<string, unknown> = {};
    if (!filters.includeHidden) {
      tournamentWhere.isHidden = false;
      tournamentWhere.status = {[Op.ne]: 'draft'};
    }
    if (filters.track) tournamentWhere.track = filters.track;
    if (filters.seriesId) tournamentWhere.seriesId = filters.seriesId;
    if (filters.tournamentId) tournamentWhere.id = filters.tournamentId;

    const [featuredIdsList, hiddenIdsList, orderIds] = await Promise.all([
      this.getFeaturedPlacementIds(subject),
      this.getHiddenPlacementIds(subject),
      this.getPlacementOrderIds(subject),
    ]);
    const featuredIds = new Set(featuredIdsList);
    const hiddenIds = new Set(hiddenIdsList);

    const rows = await TournamentPlacement.findAll({
      where,
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
    });

    let dtos = rows.map(r => toPlacementDto(r, featuredIds, hiddenIds));
    if (!filters.includeProfileHidden) {
      dtos = dtos.filter(d => !d.isProfileHidden);
    }
    if (filters.featuredOnly) {
      dtos = dtos.filter(d => d.isFeatured);
    }
    const sorter =
      orderIds.length > 0 ? createPlacementSorter(orderIds) : sortPlacementsDefault;
    dtos.sort(sorter);
    return dtos;
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

  async setFeaturedPlacementIds(
    subject: PlacementSubject,
    placementIds: number[],
  ): Promise<number[]> {
    const unique = [...new Set(placementIds.map(Number).filter(n => Number.isFinite(n)))].slice(
      0,
      5,
    );

    const owned = await this.getPlacements(subject, {includeHidden: true, includePending: true});
    const ownedIds = new Set(owned.map(p => p.id));
    const filtered = unique.filter(id => ownedIds.has(id));

    if (subject.playerId) {
      await Player.update(
        {featuredPlacementIds: filtered.length ? filtered : null},
        {where: {id: subject.playerId}},
      );
    } else if (subject.creatorId) {
      await Creator.update(
        {featuredPlacementIds: filtered.length ? filtered : null},
        {where: {id: subject.creatorId}},
      );
    }

    return filtered;
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

    const featuredIds = await this.getFeaturedPlacementIds(subject);
    const nextFeatured = featuredIds.filter(id => !filtered.includes(id));

    if (subject.playerId) {
      await Player.update(
        {
          hiddenPlacementIds: filtered.length ? filtered : null,
          featuredPlacementIds: nextFeatured.length ? nextFeatured : null,
        },
        {where: {id: subject.playerId}},
      );
    } else if (subject.creatorId) {
      await Creator.update(
        {
          hiddenPlacementIds: filtered.length ? filtered : null,
          featuredPlacementIds: nextFeatured.length ? nextFeatured : null,
        },
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
      placementOrderIds?: unknown;
      hiddenPlacementIds?: unknown;
    },
  ): Promise<PlacementDisplayPrefs> {
    const updates: Record<string, unknown> = {};
    let placementCardLayout = await this.getPlacementCardLayout(subject);
    let hiddenPlacementIds = await this.getHiddenPlacementIds(subject);
    let placementOrderIds = await this.getPlacementOrderIds(subject);

    if (prefs.cardLayout !== undefined) {
      placementCardLayout = normalizePlacementCardLayout(prefs.cardLayout);
      updates.placementCardLayout = placementCardLayout;
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

    if (Object.keys(updates).length > 0) {
      if (subject.playerId) {
        await Player.update(updates, {where: {id: subject.playerId}});
      } else if (subject.creatorId) {
        await Creator.update(updates, {where: {id: subject.creatorId}});
      }
    }

    return {
      placementCardLayout,
      hiddenPlacementIds,
      placementOrderIds,
    };
  }
}

export {placementInclude};
