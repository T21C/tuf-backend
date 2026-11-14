import {DataTypes, Model, Optional} from 'sequelize';
import User from '@/models/auth/User.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('levels');

export interface ZenCurationSessionAttributes {
  userId: string;
  payload: Record<string, unknown>;
  updatedAt: Date;
}

type ZenCurationSessionCreationAttributes = Optional<
  ZenCurationSessionAttributes,
  'payload' | 'updatedAt'
>;

class ZenCurationSession
  extends Model<ZenCurationSessionAttributes, ZenCurationSessionCreationAttributes>
  implements ZenCurationSessionAttributes
{
  declare userId: string;
  declare payload: Record<string, unknown>;
  declare updatedAt: Date;
  declare user?: User;
}

ZenCurationSession.init(
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
    tableName: 'zen_curation_sessions',
    timestamps: false,
  },
);

ZenCurationSession.belongsTo(User, {
  foreignKey: 'userId',
  as: 'user',
});

export default ZenCurationSession;
