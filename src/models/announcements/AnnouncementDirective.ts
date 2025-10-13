import {Model, DataTypes} from 'sequelize';
import sequelize from '../../config/db.js';
import { now } from 'sequelize/lib/utils';
import { IAnnouncementDirective, DirectiveCondition } from '../../interfaces/models/index.js';
import DirectiveAction from './DirectiveAction.js';

class AnnouncementDirective extends Model<IAnnouncementDirective> implements IAnnouncementDirective {
  declare id: number;
  declare difficultyId: number;
  declare name: string;
  declare description: string;
  declare mode: 'STATIC' | 'CONDITIONAL';
  declare triggerType: 'PASS' | 'LEVEL';
  declare condition: DirectiveCondition;
  declare isActive: boolean;
  declare firstOfKind: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare actions?: DirectiveAction[];
}

AnnouncementDirective.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    difficultyId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'difficulties',
        key: 'id',
      },
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    description: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    mode: {
      type: DataTypes.ENUM('STATIC', 'CONDITIONAL'),
      allowNull: false,
      defaultValue: 'STATIC',
    },
    triggerType: {
      type: DataTypes.ENUM('PASS', 'LEVEL'),
      allowNull: false,
      defaultValue: 'PASS',
    },
    condition: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    firstOfKind: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
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
    tableName: 'announcement_directives',
    indexes: [
      {
        fields: ['difficultyId'],
      }
    ],
  },
);

// Set up association
AnnouncementDirective.hasMany(DirectiveAction, {
  foreignKey: 'directiveId',
  as: 'actions',
  onDelete: 'CASCADE',
});

export default AnnouncementDirective;
