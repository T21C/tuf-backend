import {DataTypes, Model, Optional} from 'sequelize';
import User from '@/models/auth/User.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('notifications');

export interface ReferenceWatchAttributes {
  id: number;
  userId: string;
  difficultyId: number;
  createdAt: Date;
}

type ReferenceWatchCreationAttributes = Optional<ReferenceWatchAttributes, 'id' | 'createdAt'>;

class ReferenceWatch
  extends Model<ReferenceWatchAttributes, ReferenceWatchCreationAttributes>
  implements ReferenceWatchAttributes
{
  declare id: number;
  declare userId: string;
  declare difficultyId: number;
  declare createdAt: Date;

  declare user?: User;
}

ReferenceWatch.init(
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {model: 'users', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    difficultyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'reference_watches',
    timestamps: false,
    indexes: [
      {
        name: 'reference_watches_user_id_difficulty_id',
        unique: true,
        fields: ['userId', 'difficultyId'],
      },
      {
        name: 'reference_watches_difficulty_id',
        fields: ['difficultyId'],
      },
    ],
  },
);

export default ReferenceWatch;
