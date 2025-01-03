import {Model} from 'sequelize';

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

// Level interface
export interface ILevel extends IBaseModel {
  song: string;
  artist: string;
  creator: string;
  charter: string;
  vfxer: string;
  team: string;
  diffId: number;
  baseScore: number | null;
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
  previousDiffId: number | null;
  isAnnounced: boolean;
  isDeleted: boolean;
  isHidden: boolean;
  // Associations
  passes?: IPass[];
  difficulty?: IDifficulty;
  previousDifficulty?: IDifficulty;
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
  // Associations
  level?: ILevel;
  player?: IPlayer;
  judgements?: IJudgement;
}

// Player interface
export interface IPlayer extends IBaseModel {
  name: string;
  country: string;
  isBanned: boolean;
  pfp?: string | null;
  discordId?: string | null;
  discordUsername?: string | null;
  discordAvatarId?: string | null;
  discordAvatar?: string | null;

  // Associations
  passes?: IPass[];

  // Virtual fields
  rankedScore?: number;
  generalScore?: number;
  ppScore?: number;
  wfScore?: number;
  score12k?: number;
  avgXacc?: number;
  totalPasses?: number;
  universalPasses?: number;
  worldsFirstPasses?: number;
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
