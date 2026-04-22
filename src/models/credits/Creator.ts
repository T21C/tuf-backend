import {Model, DataTypes} from 'sequelize';
import {ICreator} from '@/server/interfaces/models/index.js';
import User from '@/models/auth/User.js';
import LevelCredit from '@/models/levels/LevelCredit.js';
import {CreatorAlias} from './CreatorAlias.js';
import Team from './Team.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
const sequelize = getSequelizeForModelGroup('credits');

class Creator extends Model implements ICreator {
  declare id: number;
  declare name: string;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare verificationStatus: 'declined' | 'pending' | 'conditional' | 'allowed';
  declare userId: string | null;
  /** Up to 5 curation type ids to show on the creator profile header (JSON array in DB). */
  declare displayCurationTypeIds: number[] | null;

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
    verificationStatus: {
      type: DataTypes.ENUM('declined', 'pending', 'conditional', 'allowed'),
      allowNull: false,
      defaultValue: 'allowed',
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    displayCurationTypeIds: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    sequelize,
    tableName: 'creators',
    indexes: [
      { fields: ['verificationStatus'] },
    ],
  },
);

export default Creator;
