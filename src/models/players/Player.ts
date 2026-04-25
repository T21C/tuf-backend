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
  declare bannerPreset: string | null;
  declare customBannerId: string | null;
  declare customBannerUrl: string | null;
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
