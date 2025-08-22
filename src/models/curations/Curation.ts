import {Model, DataTypes, Optional} from 'sequelize';
import sequelize from '../../config/db.js';
import CurationSchedule from './CurationSchedule.js';

export interface ICuration {
  id: number;
  levelId: number;
  typeId: number;
  shortDescription: string | null;
  description: string | null;
  previewLink: string | null;
  customCSS: string | null;
  customColor: string | null;
  assignedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

type CurationAttributes = ICuration;
type CurationCreationAttributes = Optional<
  CurationAttributes,
  'id' | 'createdAt' | 'updatedAt'
>;

class Curation
  extends Model<CurationAttributes, CurationCreationAttributes>
  implements ICuration
{
  declare id: number;
  declare levelId: number;
  declare typeId: number;
  declare shortDescription: string | null;
  declare description: string | null;
  declare previewLink: string | null;
  declare customCSS: string | null;
  declare customColor: string | null;
  declare assignedBy: string;
  declare createdAt: Date;
  declare updatedAt: Date;

  declare curationSchedules: CurationSchedule[];
}

Curation.init(
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
    typeId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'curation_types',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    shortDescription: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: "",
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    previewLink: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'CDN link to preview image/gif',
    },
    customCSS: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    customColor: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    assignedBy: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Discord ID of the person who assigned this curation',
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
    tableName: 'curations',
    timestamps: true,
    indexes: [
      {
        fields: ['levelId'],
      },
      {
        fields: ['typeId'],
      },
      {
        fields: ['assignedBy'],
      },
      {
        fields: ['createdAt'],
      },
    ],
  }
);

export default Curation;
