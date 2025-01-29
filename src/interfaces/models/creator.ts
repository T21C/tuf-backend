import {IBaseModel} from './base.js';

export interface ICreator extends IBaseModel {
  name: string;
  aliases: string[];
}
