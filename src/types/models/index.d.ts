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
  baseScore: number;
  isCleared: boolean;
  clears: number;
  vidLink: string;
  dlLink: string;
  workshopLink: string;
  publicComments: string;
  toRate: boolean;
  rerateReason: string;
  rerateNum: string;
  isDeleted: boolean;
  // Associations
  passes?: IPass[];
  difficulty?: IDifficulty;
}

// Pass interface
export interface IPass extends IBaseModel {
  levelId: number;
  speed: number | null;
  playerId: number;
  feelingRating: string | null;
  vidTitle: string | null;
  vidLink: string | null;
  vidUploadTime: Date | null;
  is12K: boolean | null;
  is16K: boolean | null;
  isNoHoldTap: boolean | null;
  isLegacyPass: boolean | null;
  isWorldsFirst: boolean | null;
  accuracy: number | null;
  scoreV2: number | null;
  isDeleted: boolean | null;
  // Associations
  level?: ILevel;
  player?: IPlayer;
  judgement?: IJudgement;
}

// Player interface
export interface IPlayer extends IBaseModel {
  name: string;
  country: string;
  isBanned: boolean;
  pfp?: string | null;

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
  topDiff?: string;
  top12kDiff?: string;
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
  legacy: number;
  type: 'PGU' | 'SPECIAL'; // To distinguish between PGU and special ratings
  icon: string; // The icon filename from iconResolver
  legacy_icon: string | null;
}
