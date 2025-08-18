import {Model, DataTypes, Optional} from 'sequelize';
import sequelize from '../../config/db.js';

export interface ICurationSchedule {
  id: number;
  levelId: number;
  targetDate: Date;
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
  declare levelId: number;
  declare targetDate: Date;
  declare isActive: boolean;
  declare scheduledBy: string;
  declare createdAt: Date;
  declare updatedAt: Date;
}

CurationSchedule.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    levelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'levels',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    targetDate: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'Target date for when this curation should be featured',
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
        fields: ['levelId'],
      },
      {
        fields: ['targetDate'],
      },
      {
        fields: ['isActive'],
      },
      {
        fields: ['scheduledBy'],
      },
    ],
  }
);

export default CurationSchedule;
