import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/db';
import { ILevel } from '../types/models';
import Pass from './Pass';

class Level extends Model<ILevel> implements ILevel {
  public id!: number;
  public song!: string;
  public artist!: string;
  public creator!: string;
  public charter!: string;
  public vfxer!: string;
  public team!: string;
  public diff!: number;
  public legacyDiff!: number;
  public pguDiff!: string;
  public pguDiffNum!: number;
  public newDiff!: number;
  public baseScore!: number;
  public baseScoreDiff!: string;
  public isCleared!: boolean;
  public clears!: number;
  public vidLink!: string;
  public dlLink!: string;
  public workshopLink!: string;
  public publicComments!: string;
  public toRate!: boolean;
  public rerateReason!: string;
  public rerateNum!: string;
  public isDeleted!: boolean;
  public createdAt!: Date;
  public updatedAt!: Date;
}

Level.init({
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  song: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  artist: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  creator: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  charter: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  vfxer: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  team: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  diff: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  legacyDiff: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  pguDiff: {
    type: DataTypes.STRING,
    allowNull: true
  },
  pguDiffNum: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  newDiff: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  baseScore: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  baseScoreDiff: {
    type: DataTypes.STRING,
    allowNull: true
  },
  isCleared: {
    type: DataTypes.BOOLEAN,
    allowNull: true
  },
  clears: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  vidLink: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  dlLink: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  workshopLink: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  publicComments: {
    type: DataTypes.STRING,
    allowNull: true
  },
  toRate: {
    type: DataTypes.BOOLEAN,
    allowNull: true
  },
  rerateReason: {
    type: DataTypes.STRING,
    allowNull: true
  },
  rerateNum: {
    type: DataTypes.STRING,
    allowNull: true
  },
  isDeleted: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: true
  }
}, {
  sequelize,
  tableName: 'levels',
  indexes: [
    { fields: [{ name: 'song', length: 255 }] },
    { fields: [{ name: 'artist', length: 255 }] },
    { fields: [{ name: 'charter', length: 255 }] },
    { fields: [{ name: 'diff' }] }
  ]
});


export default Level;