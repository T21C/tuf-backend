import {DataTypes, Model, Optional} from 'sequelize';
import sequelize from '../../config/db.js';
import {IPass} from '../../interfaces/models/index.js';
import Level from '../levels/Level.js';
import Player from '../players/Player.js';
import Judgement from './Judgement.js';

type PassAttributes = IPass;
type PassCreationAttributes = Optional<
  PassAttributes,
  'id' | 'createdAt' | 'updatedAt'
>;

class Pass
  extends Model<PassAttributes, PassCreationAttributes>
  implements PassAttributes
{
  declare id: number;
  declare levelId: number;
  declare speed: number | null;
  declare playerId: number;
  declare feelingRating: string | null;
  declare vidTitle: string | null;
  declare videoLink: string | null;
  declare vidUploadTime: Date;
  declare is12K: boolean | null;
  declare is16K: boolean | null;
  declare isNoHoldTap: boolean | null;
  declare isWorldsFirst: boolean | null;
  declare accuracy: number | null;
  declare scoreV2: number | null;
  declare isHidden: boolean | null;
  declare isDeleted: boolean | null;
  declare isAnnounced: boolean | null;
  declare isDuplicate: boolean | null;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Virtual fields from associations
  declare level?: Level;
  declare player?: Player;
  declare judgements?: Judgement;
}

Pass.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    levelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'levels',
        key: 'id',
      },
    },
    speed: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
    playerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'players',
        key: 'id',
      },
    },
    feelingRating: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    vidTitle: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    videoLink: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    vidUploadTime: {
      type: DataTypes.DATE,
      get() {
        const date = this.getDataValue('vidUploadTime');
        return date instanceof Date && !isNaN(date.getTime()) ? date : null;
      },
      set(value: any) {
        if (!value) {
          const defaultDate = new Date('2023-07-27 07:27:27');
          this.setDataValue('vidUploadTime', defaultDate);
          return;
        }

        const date = new Date(value);
        if (date instanceof Date && !isNaN(date.getTime())) {
          this.setDataValue('vidUploadTime', date);
        } else {
          const defaultDate = new Date('2023-01-01 07:27:27');
          this.setDataValue('vidUploadTime', defaultDate);
        }
      },
    },
    is12K: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    },
    is16K: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    },
    isNoHoldTap: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    },
    isWorldsFirst: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    },
    accuracy: {
      type: DataTypes.VIRTUAL,
      get() {
        return this.judgements?.accuracy;
      },
    },
    scoreV2: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
    isHidden: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
    },
    isDeleted: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
    },
    isAnnounced: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
    },
    isDuplicate: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
      comment: 'Indicates if this pass is a duplicate clear of another level',
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'passes',
    indexes: [
      {fields: ['playerId']},
      {fields: ['levelId']},
      {fields: ['isWorldsFirst']},
      {fields: ['isDuplicate']},
      //{fields: ['isHidden']},
    ],
  },
);

export default Pass;
