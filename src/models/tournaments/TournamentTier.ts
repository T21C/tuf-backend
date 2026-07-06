import {DataTypes, Model, Optional} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('tournaments');

export type TournamentTierKind =
  | 'ordinal'
  | 'bracket'
  | 'round'
  | 'stage'
  | 'qualifier'
  | 'custom';

export interface TournamentTierAttributes {
  id: number;
  tournamentId: number;
  code: string;
  label: string;
  kind: TournamentTierKind;
  rankWeight: number;
  isPodium: boolean;
  isShowcaseEligible: boolean;
  color: string | null;
  iconKey: string | null;
  iconAssetId: string | null;
  iconUrl: string | null;
  cardBackgroundAssetId: string | null;
  cardBackgroundUrl: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

type TournamentTierCreationAttributes = Optional<
  TournamentTierAttributes,
  | 'id'
  | 'kind'
  | 'rankWeight'
  | 'isPodium'
  | 'isShowcaseEligible'
  | 'color'
  | 'iconKey'
  | 'iconAssetId'
  | 'iconUrl'
  | 'cardBackgroundAssetId'
  | 'cardBackgroundUrl'
  | 'sortOrder'
  | 'createdAt'
  | 'updatedAt'
>;

class TournamentTier
  extends Model<TournamentTierAttributes, TournamentTierCreationAttributes>
  implements TournamentTierAttributes
{
  declare id: number;
  declare tournamentId: number;
  declare code: string;
  declare label: string;
  declare kind: TournamentTierKind;
  declare rankWeight: number;
  declare isPodium: boolean;
  declare isShowcaseEligible: boolean;
  declare color: string | null;
  declare iconKey: string | null;
  declare iconAssetId: string | null;
  declare iconUrl: string | null;
  declare cardBackgroundAssetId: string | null;
  declare cardBackgroundUrl: string | null;
  declare sortOrder: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

TournamentTier.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    tournamentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    code: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    label: {
      type: DataTypes.STRING(128),
      allowNull: false,
    },
    kind: {
      type: DataTypes.ENUM(
        'ordinal',
        'bracket',
        'round',
        'stage',
        'qualifier',
        'custom',
      ),
      allowNull: false,
      defaultValue: 'custom',
    },
    rankWeight: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 100,
    },
    isPodium: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    isShowcaseEligible: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    color: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    iconKey: {
      type: DataTypes.STRING(64),
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
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
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
    tableName: 'tournament_tiers',
  },
);

export default TournamentTier;
