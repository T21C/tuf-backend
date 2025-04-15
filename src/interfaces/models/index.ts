import {Model, Optional} from 'sequelize';
import {UserAttributes} from '../../models/User.js';
import DirectiveAction from '../../models/DirectiveAction.js';

// Base interface for common fields
export interface IBaseModel {
  id: number;
  createdAt: Date;
  updatedAt: Date;
}

// Base interface for model attributes (without id for junction tables)
export interface IBaseModelAttributes {
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreator extends IBaseModel {
  name: string;
  aliases: string[];
}

// Level interface
export interface ILevel extends IBaseModel {
  id: number;
  song: string;
  artist: string;
  creator: string;
  charter: string;
  vfxer: string;
  team: string;
  diffId: number;
  baseScore: number | null;
  previousBaseScore: number | null;
  isCleared: boolean;
  clears: number;
  videoLink: string;
  dlLink: string;
  workshopLink: string;
  publicComments: string;
  submitterDiscordId: string | null;
  toRate: boolean;
  rerateReason: string;
  rerateNum: string;
  previousDiffId: number;
  isAnnounced: boolean;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  isHidden: boolean;
  isVerified: boolean;
  teamId?: number | null;
  passes?: IPass[];
  difficulty?: IDifficulty;
  previousDifficulty?: IDifficulty;
  levelCreators?: ICreator[];
  teamObject?: ITeam;
  highestAccuracy?: number | null;
}

// Pass interface
export interface IPass extends IBaseModel {
  levelId: number;
  speed: number | null;
  playerId: number;
  feelingRating: string | null;
  vidTitle: string | null;
  videoLink: string | null;
  vidUploadTime: Date | null;
  is12K: boolean | null;
  is16K: boolean | null;
  isNoHoldTap: boolean | null;
  isWorldsFirst: boolean | null;
  accuracy: number | null;
  scoreV2: number | null;
  isAnnounced: boolean | null;
  isDeleted: boolean | null;
  isHidden: boolean | null;
  isDuplicate: boolean | null;
  createdAt: Date;
  updatedAt: Date;
  level?: ILevel;
  player?: IPlayer;
  judgements?: IJudgement;
}

// Player interface
export interface IPlayer extends IBaseModel {
  name: string;
  country: string;
  isBanned: boolean;
  isSubmissionsPaused: boolean;
  pfp?: string | null;
  discordId?: string | null;
  discordUsername?: string | null;
  discordAvatarId?: string | null;
  discordAvatar?: string | null;

  // Associations
  passes?: IPass[];
  user?: Model<UserAttributes>;

  // Virtual fields
  rankedScore?: number;
  generalScore?: number;
  ppScore?: number;
  wfScore?: number;
  score12K?: number;
  averageXacc?: number;
  totalPasses?: number;
  universalPassCount?: number;
  worldsFirstCount?: number;
  topDiff?: IDifficulty;
  top12kDiff?: IDifficulty;
}

// Rating interface
export interface IRating extends IBaseModel {
  levelId: number;
  currentDiff: string;
  lowDiff: boolean;
  requesterFR: string;
  average: string;
}

// RatingDetail interface
export interface IRatingDetail extends IBaseModel {
  ratingId: number;
  username: string;
  rating: string;
  comment: string;
}

export interface IJudgement extends IBaseModel {
  earlyDouble: number;
  earlySingle: number;
  ePerfect: number;
  perfect: number;
  lPerfect: number;
  lateSingle: number;
  lateDouble: number;
  accuracy: number | null;
}

// Model instance types
export type LevelInstance = Model<ILevel>;
export type PassInstance = Model<IPass>;
export type PlayerInstance = Model<IPlayer>;
export type RatingInstance = Model<IRating>;
export type RatingDetailInstance = Model<IRatingDetail>;
export type JudgementInstance = Model<IJudgement>;

// Add a new interface for the ratings reference table
export interface IDifficulty extends IBaseModel {
  name: string; // The display name (P1, G1, U1, etc.)
  baseScore: number;
  legacy: string;
  type: 'PGU' | 'SPECIAL'; // To distinguish between PGU and special ratings
  icon: string; // The icon filename from iconResolver
  color: string;
  legacyIcon: string | null;
  legacyEmoji: string | null;
  emoji: string;
  sortOrder: number;
  referenceLvels?: ILevel[];
}

// PassSubmission interfaces
export interface IPassSubmissionJudgements {
  passSubmissionId: number;
  earlyDouble: number;
  earlySingle: number;
  ePerfect: number;
  perfect: number;
  lPerfect: number;
  lateSingle: number;
  lateDouble: number;
}

export interface IPassSubmissionFlags {
  passSubmissionId: number;
  is12K: boolean;
  isNoHoldTap: boolean;
  is16K: boolean;
}

export interface IPassSubmission extends IBaseModel {
  levelId: number;
  speed: number;
  passer: string;
  feelingDifficulty: string;
  title: string;
  videoLink: string;
  rawTime: Date;
  submitterDiscordUsername?: string;
  submitterEmail?: string;
  submitterDiscordId?: string;
  submitterDiscordPfp?: string;
  status: 'pending' | 'approved' | 'declined';
  assignedPlayerId?: number | null;

  // Associations
  assignedPlayer?: IPlayer;
  judgements?: IPassSubmissionJudgements;
  flags?: IPassSubmissionFlags;
  level?: ILevel;
}

export interface ITeam extends IBaseModel {
  name: string;
  members: ICreator[];
  aliases: string[];
  description?: string | null;
}

export interface IAnnouncementChannel {
  id?: number;
  label: string;
  webhookUrl: string;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAnnouncementRole {
  id?: number;
  roleId: string;
  label: string;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export type DirectiveCondition = {
  type: 'ACCURACY' | 'WORLDS_FIRST' | 'BASE_SCORE' | 'CUSTOM';
  value?: number | string;
  operator?: 'EQUAL' | 'GREATER_THAN' | 'LESS_THAN' | 'GREATER_THAN_EQUAL' | 'LESS_THAN_EQUAL';
  customFunction?: string; // JavaScript function as string
}

export interface IAnnouncementDirective {
  id?: number;
  difficultyId: number;
  name: string;
  description: string;
  mode: 'STATIC' | 'CONDITIONAL';
  triggerType: 'PASS' | 'LEVEL';
  condition: DirectiveCondition;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  actions?: DirectiveAction[];
  firstOfKind: boolean;
}

