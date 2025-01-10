import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/db';
import Level from './Level';
import Creator from './Creator';

export enum CreditRole {
  CREATOR = 'creator',
  CHARTER = 'charter',
  VFXER = 'vfxer',
  TEAM_MEMBER = 'team_member'
}

class LevelCredit extends Model {
  declare id: number;
  declare levelId: number;
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
      autoIncrement: true
    },
    levelId: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: {
        model: 'levels',
        key: 'id',
      },
    },
    creatorId: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: {
        model: 'creators',
        key: 'id',
      },
    },
    role: {
      type: DataTypes.ENUM(...Object.values(CreditRole)),
      primaryKey: true,
    },
    isVerified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    }
  },
  {
    sequelize,
    tableName: 'level_credits',
    timestamps: false,
  }
);

export default LevelCredit; 