import {Model, DataTypes} from 'sequelize';
import sequelize from '../config/db.js';
import {IAnnouncementChannel} from '../interfaces/models/index.js';
import { now } from 'sequelize/lib/utils';

class AnnouncementChannel extends Model<IAnnouncementChannel> implements IAnnouncementChannel {
  declare id: number;
  declare label: string;
  declare webhookUrl: string;
  declare isActive: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;
}

AnnouncementChannel.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    label: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    webhookUrl: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: now
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: now
    },
  },
  {
    sequelize,
    tableName: 'announcement_channels',
    indexes: [
      {
        fields: ['is_active'],
      },
      {
        fields: ['label'],
      },
    ],
  },
);

export default AnnouncementChannel; 