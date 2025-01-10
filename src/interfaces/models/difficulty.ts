import { IBaseModel } from './base';

export interface IDifficulty extends IBaseModel {
  name: string;
  shortName: string;
  sortOrder: number;
  baseScore: number;
  color: string;
} 