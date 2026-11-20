import { DataTypes, Model } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('badges');

export class BadgeDefinition extends Model {
  declare id: number;
  declare audience: 'player' | 'creator';
  declare slug: string;
  declare name: string;
  declare secret: boolean;
  declare enabled: boolean;
  declare reducer: string;
  declare grantMode: string;
  declare identityMode: string;
  declare backfill: string;
  declare curve: unknown;
  declare tierLabels: unknown;
  declare weight: number;
  declare display: unknown;
  declare confirmMode: string;
  declare params: unknown;
  declare publishedAt: Date | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

BadgeDefinition.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    audience: { type: DataTypes.STRING(16), allowNull: false },
    slug: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(80), allowNull: false },
    secret: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    reducer: { type: DataTypes.STRING(32), allowNull: false },
    grantMode: { type: DataTypes.STRING(32), allowNull: false },
    identityMode: { type: DataTypes.STRING(32), allowNull: false },
    backfill: { type: DataTypes.STRING(16), allowNull: false },
    curve: { type: DataTypes.JSON, allowNull: false },
    tierLabels: { type: DataTypes.JSON, allowNull: false },
    weight: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 1 },
    display: { type: DataTypes.JSON, allowNull: false },
    confirmMode: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'none' },
    params: { type: DataTypes.JSON, allowNull: false },
    publishedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'badge_definitions' },
);

export class BadgeSet extends Model {
  declare id: number;
  declare name: string;
  declare kind: 'difficulty' | 'chart';
  declare values: unknown;
  declare createdAt: Date;
  declare updatedAt: Date;
}

BadgeSet.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    kind: { type: DataTypes.STRING(16), allowNull: false },
    values: { type: DataTypes.JSON, allowNull: false },
  },
  { sequelize, tableName: 'badge_sets' },
);

export class PassBadgeSnapshot extends Model {
  declare passId: number;
  declare diffId: number | null;
  declare baseScore: number | null;
  declare ppBaseScore: number | null;
  declare curationTypeIds: number[];
  declare charterIds: number[];
  declare vfxerIds: number[];
  declare createdAt: Date;
}

PassBadgeSnapshot.init(
  {
    passId: { type: DataTypes.INTEGER, primaryKey: true },
    diffId: { type: DataTypes.INTEGER, allowNull: true },
    baseScore: { type: DataTypes.DOUBLE, allowNull: true },
    ppBaseScore: { type: DataTypes.DOUBLE, allowNull: true },
    curationTypeIds: { type: DataTypes.JSON, allowNull: false },
    charterIds: { type: DataTypes.JSON, allowNull: false },
    vfxerIds: { type: DataTypes.JSON, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'pass_badge_snapshots', updatedAt: false },
);

export class BadgeState extends Model {
  declare id: number;
  declare ownerType: 'player' | 'creator';
  declare ownerId: number;
  declare definitionId: number;
  declare tier: number;
  declare credit: number;
  declare barFrom: number;
  declare barTo: number;
  declare barValue: number;
  declare provingPassIds: number[];
  declare earnedAt: Date | null;
  declare tierLabel: string | null;
  declare snapshotIds: number[] | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

BadgeState.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    ownerType: { type: DataTypes.STRING(16), allowNull: false },
    ownerId: { type: DataTypes.INTEGER, allowNull: false },
    definitionId: { type: DataTypes.INTEGER, allowNull: false },
    tier: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    credit: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
    barFrom: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
    barTo: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
    barValue: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
    provingPassIds: { type: DataTypes.JSON, allowNull: false },
    earnedAt: { type: DataTypes.DATE, allowNull: true },
    tierLabel: { type: DataTypes.STRING(40), allowNull: true },
    snapshotIds: { type: DataTypes.JSON, allowNull: true },
  },
  { sequelize, tableName: 'badge_states' },
);

export class BadgeEquip extends Model {
  declare id: number;
  declare ownerType: 'player' | 'creator';
  declare ownerId: number;
  declare slot: number;
  declare definitionId: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

BadgeEquip.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    ownerType: { type: DataTypes.STRING(16), allowNull: false },
    ownerId: { type: DataTypes.INTEGER, allowNull: false },
    slot: { type: DataTypes.TINYINT, allowNull: false },
    definitionId: { type: DataTypes.INTEGER, allowNull: false },
  },
  { sequelize, tableName: 'badge_equips' },
);

export class BadgeReview extends Model {
  declare id: number;
  declare definitionId: number;
  declare passId: number;
  declare videoUrl: string;
  declare status: 'pending' | 'approved' | 'rejected';
  declare reviewerId: string | null;
  declare reviewedAt: Date | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

BadgeReview.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    definitionId: { type: DataTypes.INTEGER, allowNull: false },
    passId: { type: DataTypes.INTEGER, allowNull: false },
    videoUrl: { type: DataTypes.TEXT, allowNull: false },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
    reviewerId: { type: DataTypes.UUID, allowNull: true },
    reviewedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'badge_reviews' },
);

export class BadgeJob extends Model {
  declare id: number;
  declare scope: string;
  declare definitionId: number | null;
  declare playerId: number | null;
  declare creatorId: number | null;
  declare levelId: number | null;
  declare packId: number | null;
  declare replaceState: boolean;
  declare status: string;
  declare skipPlaceholder: number;
  declare skipUnknownTime: number;
  declare skipMissingDifficulty: number;
  declare summary: string | null;
  declare error: string | null;
  declare processed: number;
  declare total: number;
  declare playerTotal: number;
  declare creatorTotal: number;
  declare playersProcessed: number;
  declare creatorsProcessed: number;
  declare phase: string | null;
  declare badgeCursor: number;
  declare badgeTotal: number;
  declare currentDefinitionId: number | null;
  declare currentOwnerId: number | null;
  declare currentOwnerName: string | null;
  declare heartbeatAt: Date | null;
  declare etaMs: number | null;
  declare etaSamples: { t: number; p: number }[] | null;
  declare definitionProgress: Record<string, number> | null;
  declare definitionTimings: { id: number; name: string; audience: string; runs: number; totalMs: number }[] | null;
  declare startFrom: number;
  declare createdAt: Date;
  declare startedAt: Date | null;
  declare finishedAt: Date | null;
}

BadgeJob.init(
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    scope: { type: DataTypes.STRING(16), allowNull: false },
    definitionId: { type: DataTypes.INTEGER, allowNull: true },
    playerId: { type: DataTypes.INTEGER, allowNull: true },
    creatorId: { type: DataTypes.INTEGER, allowNull: true },
    levelId: { type: DataTypes.INTEGER, allowNull: true },
    packId: { type: DataTypes.INTEGER, allowNull: true },
    replaceState: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
    skipPlaceholder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    skipUnknownTime: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    skipMissingDifficulty: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    summary: { type: DataTypes.TEXT, allowNull: true },
    error: { type: DataTypes.TEXT, allowNull: true },
    processed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    total: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    playerTotal: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    creatorTotal: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    playersProcessed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    creatorsProcessed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    phase: { type: DataTypes.STRING(16), allowNull: true },
    badgeCursor: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    badgeTotal: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    currentDefinitionId: { type: DataTypes.INTEGER, allowNull: true },
    currentOwnerId: { type: DataTypes.INTEGER, allowNull: true },
    currentOwnerName: { type: DataTypes.STRING(80), allowNull: true },
    heartbeatAt: { type: DataTypes.DATE, allowNull: true },
    etaMs: { type: DataTypes.INTEGER, allowNull: true },
    etaSamples: { type: DataTypes.JSON, allowNull: true },
    definitionProgress: { type: DataTypes.JSON, allowNull: true },
    definitionTimings: { type: DataTypes.JSON, allowNull: true },
    startFrom: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    startedAt: { type: DataTypes.DATE, allowNull: true },
    finishedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'badge_jobs', updatedAt: false },
);
