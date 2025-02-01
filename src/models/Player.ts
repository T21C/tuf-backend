import {
  DataTypes,
  Model,
  Optional,
  HasManyGetAssociationsMixin,
  HasOneGetAssociationMixin,
} from 'sequelize';
import sequelize from '../config/db.js';
import {IDifficulty, IPass, IPlayer} from '../interfaces/models/index.js';
import Pass from './Pass.js';
import User from './User.js';

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
  declare pfp: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Associations
  declare passes?: IPass[];
  declare getPasses: HasManyGetAssociationsMixin<Pass>;
  declare user?: User;
  declare getUser: HasOneGetAssociationMixin<User>;

  // Virtual fields
  declare rankedScore?: number;
  declare generalScore?: number;
  declare ppScore?: number;
  declare wfScore?: number;
  declare score12K?: number;
  declare averageXacc?: number;
  declare totalPasses?: number;
  declare universalPassCount?: number;
  declare worldsFirstCount?: number;
  declare topDiff?: IDifficulty;
  declare top12kDiff?: IDifficulty;
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
    pfp: {
      type: DataTypes.STRING,
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
