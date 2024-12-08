import { Model } from 'sequelize';

// Base interface for common fields
export interface IBaseModel {
  id: number;
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
  diff: number;
  legacyDiff: number;
  pguDiff: string;
  pguDiffNum: number;
  newDiff: number;
  baseScore: number;
  baseScoreDiff: string;
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
  levelPasses?: IPass[];
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
  judgements?: IJudgement;
  player?: IPlayer;
}

// Player interfaces
export interface IPlayer extends IBaseModel {
  id: number;
  name: string;
  country: string;
  isBanned: boolean;
  pfp?: string | null;
  playerPasses?: IPass[];
  createdAt?: Date;
  updatedAt?: Date;

  // Virtual fields
  rankedScore?: number;
  generalScore?: number;
  ppScore?: number;
  wfScore?: number;
  score12k?: number;
  avgXacc?: number;
  totalPasses?: number;
  universalPasses?: number;
  WFPasses?: number;
  topDiff?: string;
  top12kDiff?: string;
}

// Rating interface
export interface IRating extends Omit<IBaseModel, 'id'> {
  levelId: number;  // Primary key instead of id
  currentDiff: string;
  lowDiff: boolean;
  rerateNum: string;
  requesterFR: string;
  average: string;
  comments: string;
  rerateReason: string;
}

// RatingDetail interface
export interface IRatingDetail extends IBaseModel {
  ratingId: number;
  username: string;
  rating: string;
  comment: string;
}

// Judgement interface
export interface IJudgement extends IBaseModel {
  passId: number;
  earlyDouble: number;
  earlySingle: number;
  ePerfect: number;
  perfect: number;
  lPerfect: number;
  lateSingle: number;
  lateDouble: number;
}

// RerateSubmission interface
export interface IRerateSubmission extends IBaseModel {
  levelId: string;
  song: string;
  artists: string;
  creators: string;
  videoLink: string;
  downloadLink: string;
  originalDiff: string;
  isLowDiff: boolean;
  rerateValue: number;
  requesterFR: string;
  average: number;
  comments: string;
}

// ChartSubmission interface
export interface IChartSubmission extends IBaseModel {
  artist: string;
  charter: string;
  diff: string;
  song: string;
  team: string;
  vfxer: string;
  videoLink: string;
  directDL: string;
  wsLink: string;
  submitterDiscordUsername: string;
  submitterEmail: string;
  status: 'pending' | 'approved' | 'declined';
  toRate: boolean;
}

// PassSubmission interfaces
export interface IPassSubmission extends IBaseModel {
  levelId: string;
  speed: number;
  passer: string;
  feelingDifficulty: string;
  title: string;
  rawVideoId: string;
  rawTime: Date;
  submitterDiscordUsername: string;
  submitterEmail: string;
  status: string;
}

export interface IPassSubmissionJudgements extends IBaseModel {
  passSubmissionId: number;
  earlyDouble: number;
  earlySingle: number;
  ePerfect: number;
  perfect: number;
  lPerfect: number;
  lateSingle: number;
  lateDouble: number;
}

export interface IPassSubmissionFlags extends IBaseModel {
  passSubmissionId: number;
  is12k: boolean;
  isNHT: boolean;
  is16k: boolean;
  isLegacy: boolean;
}

// Model instance types
export type LevelInstance = Model<ILevel>;
export type PassInstance = Model<IPass>;
export type PlayerInstance = Model<IPlayer>;
export type RatingInstance = Model<IRating>;
export type RatingDetailInstance = Model<IRatingDetail>;
export type JudgementInstance = Model<IJudgement>;
export type RerateSubmissionInstance = Model<IRerateSubmission>;
export type ChartSubmissionInstance = Model<IChartSubmission>;
export type PassSubmissionInstance = Model<IPassSubmission>;
export type PassSubmissionJudgementsInstance = Model<IPassSubmissionJudgements>;
export type PassSubmissionFlagsInstance = Model<IPassSubmissionFlags>;