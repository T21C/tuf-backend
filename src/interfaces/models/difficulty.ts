import {IBaseModel} from './base.js';

export interface IDifficulty extends IBaseModel {
  name: string;
  shortName: string;
  sortOrder: number;
  baseScore: number;
  color: string;
}
