import {
  DataTypes,
  Model,
  Optional,
  HasManyGetAssociationsMixin,
} from 'sequelize';
import sequelize from '../config/db';
import {IPlayer} from '../interfaces/models';
import Pass from './Pass';

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
  declare passes?: Pass[];
  declare getPasses: HasManyGetAssociationsMixin<Pass>;

  // Virtual fields
  declare rankedScore?: number;
  declare generalScore?: number;
  declare ppScore?: number;
  declare wfScore?: number;
  declare score12k?: number;
  declare avgXacc?: number;
  declare totalPasses?: number;
  declare universalPasses?: number;
  declare worldsFirstPasses?: number;
  declare topDiff?: string;
  declare top12kDiff?: string;
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
