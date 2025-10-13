import {Model, DataTypes} from 'sequelize';
import sequelize from '../../config/db.js';
import { now } from 'sequelize/lib/utils';
import AnnouncementChannel from './AnnouncementChannel.js';
import AnnouncementRole from './AnnouncementRole.js';

export interface IDirectiveAction {
  id?: number;
  directiveId: number;
  channelId: number;
  pingType: 'NONE' | 'ROLE' | 'EVERYONE';
  roleId?: number;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  channel?: AnnouncementChannel;
  role?: AnnouncementRole;
}

class DirectiveAction extends Model<IDirectiveAction> implements IDirectiveAction {
  declare id?: number;
  declare directiveId: number;
  declare channelId: number;
  declare pingType: 'NONE' | 'ROLE' | 'EVERYONE';
  declare roleId?: number;
  declare isActive?: boolean;
  declare createdAt?: Date;
  declare updatedAt?: Date;
  declare channel?: AnnouncementChannel;
  declare role?: AnnouncementRole;
}

DirectiveAction.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    directiveId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'announcement_directives',
        key: 'id',
      },
    },
    channelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'announcement_channels',
        key: 'id',
      },
    },
    pingType: {
      type: DataTypes.ENUM('NONE', 'ROLE', 'EVERYONE'),
      allowNull: false,
      defaultValue: 'NONE',
    },
    roleId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'announcement_roles',
        key: 'id',
      },
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
    tableName: 'directive_actions',
    indexes: [
      {
        fields: ['directiveId'],
      },
      {
        fields: ['channelId'],
      },
      {
        fields: ['roleId'],
      }
    ],
  },
);

// Set up associations
DirectiveAction.belongsTo(AnnouncementChannel, {
  foreignKey: 'channelId',
  as: 'channel',
});

DirectiveAction.belongsTo(AnnouncementRole, {
  foreignKey: 'roleId',
  as: 'role',
});

export default DirectiveAction;
