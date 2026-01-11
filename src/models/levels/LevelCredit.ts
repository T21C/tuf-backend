import {Model, DataTypes} from 'sequelize';
import Level from './Level.js';
import Creator from '../credits/Creator.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

export enum CreditRole {
  CREATOR = 'creator',
  CHARTER = 'charter',
  VFXER = 'vfxer',
  TEAM_MEMBER = 'team_member',
}

class LevelCredit extends Model {
  declare id: number;
  declare levelId: number;
  declare isOwner: boolean;
  declare creatorId: number;
  declare role: CreditRole;
  declare isVerified: boolean;

  // Associations
  declare level?: Level;
  declare creator?: Creator;
}

LevelCredit.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    levelId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'levels',
        key: 'id',
      },
    },
    isOwner: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    creatorId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'creators',
        key: 'id',
      },
    },
    role: {
      type: DataTypes.ENUM(...Object.values(CreditRole)),
    },
    isVerified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  },
  {
    sequelize,
    tableName: 'level_credits',
    timestamps: false,
    indexes: [
      {
        unique: true,
        fields: ['levelId', 'creatorId', 'role'],
        name: 'level_credits_levelId_creatorId_role_unique'
      }
    ]
  },
);

export default LevelCredit;
