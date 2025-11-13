import {Model, DataTypes} from 'sequelize';
import {ICreator} from '../../interfaces/models/index.js';
import User from '../auth/User.js';
import LevelCredit from '../levels/LevelCredit.js';
import {CreatorAlias} from './CreatorAlias.js';
import Team from './Team.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('credits');

class Creator extends Model implements ICreator {
  declare id: number;
  declare name: string;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare isVerified: boolean;
  declare userId: string | null;

  declare user: User;
  declare credits?: LevelCredit[];
  declare creatorAliases: CreatorAlias[];
  declare creatorTeams: Team[];
  declare teamMemberships: any[];
}

Creator.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
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
    isVerified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id',
      },
    },
  },
  {
    sequelize,
    tableName: 'creators',
  },
);

export default Creator;
