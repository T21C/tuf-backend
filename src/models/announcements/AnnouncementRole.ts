import {Model, DataTypes} from 'sequelize';
import {IAnnouncementRole} from '../../server/interfaces/models/index.js';
import { now } from 'sequelize/lib/utils';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('announcements');


class AnnouncementRole extends Model<IAnnouncementRole> implements IAnnouncementRole {
  declare id?: number;
  declare roleId: string;
  declare label: string;
  declare messageFormat?: string;
  declare isActive: boolean;
  declare createdAt?: Date;
  declare updatedAt?: Date;
}

AnnouncementRole.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    roleId: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    label: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    messageFormat: {
      type: DataTypes.STRING(500),
      allowNull: true,
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
    tableName: 'announcement_roles',
    indexes: [
      {
        fields: ['isActive'],
      },
      {
        fields: ['label'],
      },
    ],
  },
);

export default AnnouncementRole;
