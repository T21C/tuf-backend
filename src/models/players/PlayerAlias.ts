import {Model, DataTypes, Optional} from 'sequelize';
import Player from './Player.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('players');

export interface PlayerAliasAttributes {
  id: number;
  playerId: number;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

type PlayerAliasCreationAttributes = Optional<PlayerAliasAttributes, 'id' | 'createdAt' | 'updatedAt'>;

class PlayerAlias extends Model<PlayerAliasAttributes, PlayerAliasCreationAttributes> {
  declare id: number;
  declare playerId: number;
  declare name: string;
  declare createdAt: Date;
  declare updatedAt: Date;

  declare player?: Player;
}

PlayerAlias.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    playerId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'players',
        key: 'id',
      },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
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
    tableName: 'player_aliases',
    indexes: [
      {fields: ['playerId']},
      {fields: ['name']},
      {unique: true, fields: ['playerId', 'name']},
    ],
  },
);

export default PlayerAlias;
