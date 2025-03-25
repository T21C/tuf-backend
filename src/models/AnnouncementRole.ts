import {Model, DataTypes} from 'sequelize';
import sequelize from '../config/db.js';
import {IAnnouncementRole} from '../interfaces/models/index.js';
import { now } from 'sequelize/lib/utils';


class AnnouncementRole extends Model<IAnnouncementRole> implements IAnnouncementRole {
  declare id?: number;
  declare roleId: string;
  declare label: string;
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
        fields: ['is_active'],
      },
      {
        fields: ['label'],
      },
    ],
  },
);

export default AnnouncementRole; 