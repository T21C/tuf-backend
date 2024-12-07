import { DataTypes } from 'sequelize';
import sequelize from '../config/db';
import { IPlayer } from '../types/models';
import BaseModel from './BaseModel';
import Pass from './Pass';

class Player extends BaseModel implements IPlayer {
  declare id: number;
  declare name: string;
  declare country: string;
  declare isBanned: boolean;

  // Virtual fields
  declare rankedScore?: number;
  declare generalScore?: number;
  declare ppScore?: number;
  declare wfScore?: number;
  declare score12k?: number;
  declare avgXacc?: number;
  declare totalPasses?: number;
  declare universalPasses?: number;
  declare WFPasses?: number;
  declare topDiff?: string;
  declare top12kDiff?: string;

  // Associations
  declare playerPasses?: Pass[];
}

Player.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  country: {
    type: DataTypes.STRING(2),
    allowNull: false
  },
  isBanned: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  }
}, {
  sequelize,
  tableName: 'players'
});

export default Player;