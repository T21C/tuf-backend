import {
  DataTypes,
  Model,
  Optional,
  HasManyGetAssociationsMixin,
  HasOneGetAssociationMixin,
} from 'sequelize';
import {IPass, IPlayer} from '@/server/interfaces/models/index.js';
import Pass from '@/models/passes/Pass.js';
import User from '@/models/auth/User.js';
import PlayerStats from '@/models/players/PlayerStats.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
const sequelize = getSequelizeForModelGroup('players');

type PlayerCreationAttributes = Optional<
  IPlayer,
  'id' | 'createdAt' | 'updatedAt'
>;

class Player
  extends Model<IPlayer, PlayerCreationAttributes>
  implements IPlayer
{
  declare id: number;
  declare name: string;
  declare country: string;
  declare isBanned: boolean;
  declare isSubmissionsPaused: boolean;
  declare pfp: string | null;
  declare bio: string | null;
  declare bannerPreset: string | null;
  declare customBannerId: string | null;
  declare customBannerUrl: string | null;
  declare profileHeaderSurfaceStyle: Record<string, unknown> | null;
  declare profileHeaderSurfaceImageAssets: Record<string, { assetId: string; url: string }> | null;
  declare bioCanvas: Record<string, unknown> | null;
  declare bioCanvasImageAssets: Record<string, { assetId: string; url: string }> | null;
  /** TUFStellar subscriber icon art: `1` | `2` | `3`. */
  declare tufStellarIconVariant: string;
  /** Placement ids pinned on the profile tournaments section (max 5). */
  declare featuredPlacementIds: number[] | null;
  /** Placement ids hidden from the public profile tournaments section. */
  declare hiddenPlacementIds: number[] | null;
  /** User-defined display order for visible placements. */
  declare placementOrderIds: number[] | null;
  declare placementCardLayout: string;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare passes?: IPass[];
  declare getPasses: HasManyGetAssociationsMixin<Pass>;
  declare user?: User;
  declare getUser: HasOneGetAssociationMixin<User>;
  declare stats?: PlayerStats;
  declare getStats: HasOneGetAssociationMixin<PlayerStats>;
}

Player.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    country: {
      type: DataTypes.STRING(2),
      allowNull: false,
    },
    isBanned: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    isSubmissionsPaused: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    pfp: {
      type: DataTypes.STRING,
      allowNull: true,
      get() {
        return this.user?.avatarUrl || this.getDataValue('pfp') || null;
      },
    },
    bio: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    bannerPreset: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    customBannerId: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    customBannerUrl: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    profileHeaderSurfaceStyle: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    profileHeaderSurfaceImageAssets: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    bioCanvas: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    bioCanvasImageAssets: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    tufStellarIconVariant: {
      type: DataTypes.STRING(1),
      allowNull: false,
      defaultValue: '1',
    },
    featuredPlacementIds: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },
    hiddenPlacementIds: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },
    placementOrderIds: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },
    placementCardLayout: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'default',
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
    tableName: 'players',
    indexes: [{fields: ['name']}, {fields: ['country']}],
  },
);

export default Player;
