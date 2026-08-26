import {DataTypes, Model, Optional} from 'sequelize';
import User from '@/models/auth/User.js';
import {getSequelizeForModelGroup} from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('notifications');

export interface ChartClearNotificationMuteAttributes {
  userId: string;
  levelId: number;
  createdAt: Date;
}

type ChartClearNotificationMuteCreationAttributes = Optional<
  ChartClearNotificationMuteAttributes,
  'createdAt'
>;

class ChartClearNotificationMute
  extends Model<ChartClearNotificationMuteAttributes, ChartClearNotificationMuteCreationAttributes>
  implements ChartClearNotificationMuteAttributes
{
  declare userId: string;
  declare levelId: number;
  declare createdAt: Date;

  declare user?: User;
}

ChartClearNotificationMute.init(
  {
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true,
      references: {model: 'users', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    levelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      references: {model: 'levels', key: 'id'},
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'chart_clear_notification_mutes',
    timestamps: false,
  },
);

export default ChartClearNotificationMute;
