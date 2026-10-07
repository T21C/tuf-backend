import {DataTypes, Model, Optional} from 'sequelize';
import User from '@/models/auth/User.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('levels');

export interface ZenRatingSessionAttributes {
  userId: string;
  payload: Record<string, unknown>;
  updatedAt: Date;
}

type ZenRatingSessionCreationAttributes = Optional<
  ZenRatingSessionAttributes,
  'payload' | 'updatedAt'
>;

class ZenRatingSession
  extends Model<ZenRatingSessionAttributes, ZenRatingSessionCreationAttributes>
  implements ZenRatingSessionAttributes
{
  declare userId: string;
  declare payload: Record<string, unknown>;
  declare updatedAt: Date;

  declare user?: User;
}

ZenRatingSession.init(
  {
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true,
      references: {model: 'users', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: {},
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'zen_rating_sessions',
    timestamps: false,
  },
);

ZenRatingSession.belongsTo(User, {
  foreignKey: 'userId',
  as: 'user',
});

export default ZenRatingSession;
