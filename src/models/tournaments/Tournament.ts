import {DataTypes, Model, Optional} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('tournaments');

export type TournamentStatus = 'draft' | 'ongoing' | 'completed' | 'cancelled';
export type TournamentPlacementMode = 'profile' | 'level';
export type TournamentTrack = 'player' | 'creator';
export type TournamentCardLayout = 'classic' | 'evidence' | 'levelStyle';

export interface TournamentAttributes {
  id: number;
  shortName: string;
  fullName: string | null;
  aka: string | null;
  seriesId: number | null;
  status: TournamentStatus;
  isHidden: boolean;
  isResultsFinal: boolean;
  youtubeUrl: string | null;
  packRef: string | null;
  notes: string | null;
  externalUrl: string | null;
  organizers: string[] | null;
  ownerUserIds: string[] | null;
  startsAt: Date | null;
  endsAt: Date | null;
  sortYear: number | null;
  sortWeight: number;
  track: TournamentTrack;
  placementMode: TournamentPlacementMode;
  showBestTiersOnly: boolean;
  cardLayoutDefault: TournamentCardLayout;
  creditRoleFilter: string[] | null;
  iconAssetId: string | null;
  iconUrl: string | null;
  cardBackgroundAssetId: string | null;
  cardBackgroundUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type TournamentCreationAttributes = Optional<
  TournamentAttributes,
  | 'id'
  | 'fullName'
  | 'aka'
  | 'seriesId'
  | 'status'
  | 'isHidden'
  | 'isResultsFinal'
  | 'youtubeUrl'
  | 'packRef'
  | 'notes'
  | 'externalUrl'
  | 'organizers'
  | 'ownerUserIds'
  | 'startsAt'
  | 'endsAt'
  | 'sortYear'
  | 'sortWeight'
  | 'track'
  | 'placementMode'
  | 'showBestTiersOnly'
  | 'cardLayoutDefault'
  | 'creditRoleFilter'
  | 'iconAssetId'
  | 'iconUrl'
  | 'cardBackgroundAssetId'
  | 'cardBackgroundUrl'
  | 'createdAt'
  | 'updatedAt'
>;

class Tournament
  extends Model<TournamentAttributes, TournamentCreationAttributes>
  implements TournamentAttributes
{
  declare id: number;
  declare shortName: string;
  declare fullName: string | null;
  declare aka: string | null;
  declare seriesId: number | null;
  declare status: TournamentStatus;
  declare isHidden: boolean;
  declare isResultsFinal: boolean;
  declare youtubeUrl: string | null;
  declare packRef: string | null;
  declare notes: string | null;
  declare externalUrl: string | null;
  declare organizers: string[] | null;
  declare ownerUserIds: string[] | null;
  declare startsAt: Date | null;
  declare endsAt: Date | null;
  declare sortYear: number | null;
  declare sortWeight: number;
  declare track: TournamentTrack;
  declare placementMode: TournamentPlacementMode;
  declare showBestTiersOnly: boolean;
  declare cardLayoutDefault: TournamentCardLayout;
  declare creditRoleFilter: string[] | null;
  declare iconAssetId: string | null;
  declare iconUrl: string | null;
  declare cardBackgroundAssetId: string | null;
  declare cardBackgroundUrl: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Tournament.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    shortName: {
      type: DataTypes.STRING(128),
      allowNull: false,
      unique: true,
    },
    fullName: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    aka: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    seriesId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM('draft', 'ongoing', 'completed', 'cancelled'),
      allowNull: false,
      defaultValue: 'draft',
    },
    isHidden: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    isResultsFinal: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    youtubeUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    packRef: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    externalUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    organizers: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    ownerUserIds: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    startsAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    endsAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    sortYear: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    sortWeight: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    track: {
      type: DataTypes.ENUM('player', 'creator'),
      allowNull: false,
      defaultValue: 'player',
    },
    placementMode: {
      type: DataTypes.ENUM('profile', 'level'),
      allowNull: false,
      defaultValue: 'profile',
    },
    showBestTiersOnly: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    cardLayoutDefault: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: 'classic',
    },
    creditRoleFilter: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    iconAssetId: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    iconUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    cardBackgroundAssetId: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    cardBackgroundUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
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
    tableName: 'tournaments',
  },
);

export default Tournament;
