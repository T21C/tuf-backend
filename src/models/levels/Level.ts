import {Model, DataTypes, Optional} from 'sequelize';
import {
  ILevel,
  IPass,
  IDifficulty,
  ICreator
} from '../../server/interfaces/models/index.js';
import LevelCredit from './LevelCredit.js';
import LevelAlias from './LevelAlias.js';
import Team from '../credits/Team.js';
import Curation from '../curations/Curation.js';
import Rating from './Rating.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
import LevelTag from './LevelTag.js';
import Song from '../songs/Song.js';
import Artist from '../artists/Artist.js';
import SongCredit from '../songs/SongCredit.js';
const sequelize = getSequelizeForModelGroup('levels');

type LevelAttributes = ILevel;
type LevelCreationAttributes = Optional<
  LevelAttributes,
  'id' | 'createdAt' | 'updatedAt'
>;

class Level
  extends Model<LevelAttributes, LevelCreationAttributes>
  implements ILevel
{
  declare id: number;
  declare song: string;
  declare artist: string;
  declare songId: number | null;
  declare diffId: number;
  declare baseScore: number | null;
  declare ppBaseScore: number | null;
  declare previousBaseScore: number | null;
  declare clears: number;
  declare likes: number;
  declare ratingAccuracy: number;
  declare totalRatingAccuracyVotes: number;
  declare videoLink: string;
  declare dlLink: string;
  declare legacyDllink: string | null;
  declare workshopLink: string;
  declare publicComments: string;
  declare toRate: boolean;
  declare rerateReason: string;
  declare rerateNum: string;
  declare previousDiffId: number;
  declare isAnnounced: boolean;
  declare isDeleted: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare isHidden: boolean;
  declare isVerified: boolean;
  declare isExternallyAvailable: boolean;
  declare teamId: number | null;
  declare teamObject: Team;
  declare highestAccuracy: number | null;
  declare firstPass: IPass | null;
  // Virtual fields from associations
  declare passes?: IPass[];
  declare difficulty?: IDifficulty;
  declare previousDifficulty?: IDifficulty;
  declare levelCreators?: ICreator[];
  declare levelCredits?: LevelCredit[];
  declare aliases?: LevelAlias[] | null;
  declare curation?: Curation | null;
  declare ratings?: Rating[] | null;

  declare charter: string;
  declare vfxer: string;
  declare team: string;
  declare charters: string[];
  declare vfxers: string[];
  declare tags?: LevelTag[];
  
  // Associations for normalized song
  declare songObject?: Song;
  declare songCredits?: SongCredit[];
}

Level.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    song: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    artist: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    diffId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'difficulties',
        key: 'id',
      },
    },
    baseScore: {
      type: DataTypes.DOUBLE,
      allowNull: true,
      defaultValue: null,
    },
    ppBaseScore: {
      type: DataTypes.DOUBLE,
      allowNull: true,
      defaultValue: null,
    },
    previousBaseScore: {
      type: DataTypes.DOUBLE,
      allowNull: true,
      defaultValue: null,
    },
    videoLink: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    dlLink: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    legacyDllink: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null
    },
    workshopLink: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    publicComments: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    toRate: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    },
    rerateReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    rerateNum: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    previousDiffId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'difficulties',
        key: 'id',
      },
    },
    isAnnounced: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    isDeleted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    isHidden: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    isVerified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    isExternallyAvailable: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    teamId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'teams',
        key: 'id',
      },
    },
    songId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'songs',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
    clears: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    likes: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    ratingAccuracy: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 0,
    },
    totalRatingAccuracyVotes: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    firstPass: {
      type: DataTypes.VIRTUAL,
      get() {
        return this.passes ? this.passes.find(pass => pass.isWorldsFirst) : null;
      },
    },
    highestAccuracy: {
      type: DataTypes.VIRTUAL,
      get() {
        // If passes are loaded, find the highest accuracy
        if (this.passes && this.passes.length > 0) {
          const validPasses = this.passes.filter(pass =>
            pass.accuracy !== null &&
            !pass.isDeleted &&
            !pass.isHidden
          );

          if (validPasses.length > 0) {
            return Math.max(...validPasses.map(pass => pass.accuracy || 0));
          }
        }
        return null;
      }
    },
    charter: {
      type: DataTypes.VIRTUAL,
      get() {
        return this.levelCredits?.filter(credit => credit.role === 'charter').map(credit => credit.creator?.name).join(', ');
      },
    },
    charters: {
      type: DataTypes.VIRTUAL,
      get() {
        return this.levelCredits?.filter(credit => credit.role === 'charter').map(credit => credit.creator?.name);
      },
    },
    vfxer: {
      type: DataTypes.VIRTUAL,
      get() {
        return this.levelCredits?.filter(credit => credit.role === 'vfxer').map(credit => credit.creator?.name).join(', ');
      },
    },
    vfxers: {
      type: DataTypes.VIRTUAL,
      get() {
        return this.levelCredits?.filter(credit => credit.role === 'vfxer').map(credit => credit.creator?.name);
      },
    },
    team: {
      type: DataTypes.VIRTUAL,
      get() {
        return this.teamObject?.name;
      },
    },
    // Virtual getters that prefer normalized data
    songName: {
      type: DataTypes.VIRTUAL,
      get() {
        if (this.songObject?.name) {
          return this.songObject.name;
        }
        return this.song || '';
      },
    },
    artistName: {
      type: DataTypes.VIRTUAL,
      get() {
        // Get artist name from song's credits (first artist)
        if (this.songObject?.credits && this.songObject.credits.length > 0) {
          const firstCredit = this.songObject.credits[0];
          if (firstCredit.artist?.name) {
            return firstCredit.artist.name;
          }
        }
        return this.artist || '';
      },
    }
  },
  {
    sequelize,
    tableName: 'levels',
    indexes: [
      {fields: [{name: 'song', length: 255}]},
      {fields: [{name: 'artist', length: 255}]},
    ],
  },
);

export default Level;
