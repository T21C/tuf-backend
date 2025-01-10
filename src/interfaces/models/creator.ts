import { IBaseModel } from './base';

export interface ICreator extends IBaseModel {
  name: string;
  aliases: string[];
} 