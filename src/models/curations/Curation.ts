import { Model, DataTypes, Optional } from 'sequelize';
import CurationSchedule from './CurationSchedule.js';
import CurationType from './CurationType.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import Level from '@/models/levels/Level.js';
const sequelize = getSequelizeForModelGroup('curations');

export interface ICuration {
  id: number;
  levelId: number;
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
  declare shortDescription: string | null;
  declare description: string | null;
  declare previewLink: string | null;
  declare customCSS: string | null;
  declare customColor: string | null;
  declare assignedBy: string;
  declare createdAt: Date;
  declare updatedAt: Date;

  declare curationSchedules: CurationSchedule[];
  declare types?: CurationType[];
  declare level?: Level;

  declare setTypes: (typeIds: readonly number[], options?: object) => Promise<void>;
  declare addType: (type: number | CurationType, options?: object) => Promise<void>;
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
      unique: true,
      references: {
        model: 'levels',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    shortDescription: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: '',
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
      type: DataTypes.UUID,
      allowNull: false,
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
        fields: ['assignedBy'],
      },
      {
        fields: ['createdAt'],
      },
    ],
  }
);

export default Curation;
