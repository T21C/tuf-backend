import { DataTypes } from 'sequelize';
import sequelize from '../config/db';
import BaseModel from './BaseModel';
import Level from './Level';
import Player from './Player';
import Judgement from './Judgement';

export interface IPass {
  id: number;
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
}

class Pass extends BaseModel implements IPass {
  declare levelId: number;
  declare speed: number | null;
  declare playerId: number;
  declare feelingRating: string | null;
  declare vidTitle: string | null;
  declare vidLink: string | null;
  declare vidUploadTime: Date | null;
  declare is12K: boolean | null;
  declare is16K: boolean | null;
  declare isNoHoldTap: boolean | null;
  declare isLegacyPass: boolean | null;
  declare isWorldsFirst: boolean | null;
  declare accuracy: number | null;
  declare scoreV2: number | null;
  declare isDeleted: boolean | null;

  // Associations
  declare level?: Level;
  declare player?: Player;
  declare judgements?: Judgement;
}

Pass.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  levelId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'levels',
      key: 'id'
    }
  },
  speed: {
    type: DataTypes.FLOAT,
    allowNull: true
  },
  playerId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'players',
      key: 'id'
    }
  },
  feelingRating: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  vidTitle: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  vidLink: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  vidUploadTime: {
    type: DataTypes.DATE,
    allowNull: true,
    get() {
      const date = this.getDataValue('vidUploadTime');
      return date instanceof Date && !isNaN(date.getTime()) ? date : null;
    },
    set(value: any) {
      if (!value) {
        this.setDataValue('vidUploadTime', null);
        return;
      }
      
      const date = new Date(value);
      if (date instanceof Date && !isNaN(date.getTime())) {
        this.setDataValue('vidUploadTime', date);
      } else {
        this.setDataValue('vidUploadTime', null);
      }
    }
  },
  is12K: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: true
  },
  is16K: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: true
  },
  isNoHoldTap: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: true
  },
  isLegacyPass: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: true
  },
  isWorldsFirst: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: true
  },
  accuracy: {
    type: DataTypes.FLOAT,
    allowNull: true
  },
  scoreV2: {
    type: DataTypes.FLOAT,
    allowNull: true
  },
  isDeleted: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: true
  }
}, {
  sequelize,
  tableName: 'passes',
  indexes: [
    { fields: ['levelId'] },
    { fields: ['playerId'] },
    { fields: ['vidUploadTime'] }
  ]
});

export default Pass;