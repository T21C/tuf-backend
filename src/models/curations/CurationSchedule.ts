import {Model, DataTypes, Optional} from 'sequelize';
import sequelize from '../../config/db.js';
import Curation from './Curation.js';

export interface ICurationSchedule {
  id: number;
  curationId: number;
  weekStart: Date;
  listType: 'primary' | 'secondary';
  position: number;
  isActive: boolean;
  scheduledBy: string;
  createdAt: Date;
  updatedAt: Date;
}

type CurationScheduleAttributes = ICurationSchedule;
type CurationScheduleCreationAttributes = Optional<
  CurationScheduleAttributes,
  'id' | 'createdAt' | 'updatedAt'
>;

class CurationSchedule
  extends Model<CurationScheduleAttributes, CurationScheduleCreationAttributes>
  implements ICurationSchedule
{
  declare id: number;
  declare curationId: number;
  declare weekStart: Date;
  declare listType: 'primary' | 'secondary';
  declare position: number;
  declare isActive: boolean;
  declare scheduledBy: string;
  declare createdAt: Date;
  declare updatedAt: Date;

  declare scheduledCuration: Curation;
}

CurationSchedule.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    curationId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'curations',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    weekStart: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'Monday date for the week this curation is scheduled',
    },
    listType: {
      type: DataTypes.ENUM('primary', 'secondary'),
      allowNull: false,
      comment: 'Whether this is in the primary or secondary hall of fame list',
    },
    position: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'Position within the list (0-9)',
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    scheduledBy: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Discord ID of the person who scheduled this',
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'curation_schedules',
    timestamps: true,
    indexes: [
      {
        fields: ['curationId'],
      },
      {
        fields: ['weekStart'],
      },
      {
        fields: ['listType'],
      },
      {
        fields: ['position'],
      },
      {
        fields: ['isActive'],
      },
      {
        fields: ['scheduledBy'],
      },
      {
        unique: true,
        fields: ['weekStart', 'listType', 'position'],
        name: 'unique_week_list_position',
      },
    ],
  }
);

export default CurationSchedule;
