import {Model, DataTypes, Optional} from 'sequelize';
import sequelize from '../../config/db.js';

export interface ICurationType {
  id: number;
  name: string;
  icon: string | null;
  color: string;
  abilities: number;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

type CurationTypeAttributes = ICurationType;
type CurationTypeCreationAttributes = Optional<
  CurationTypeAttributes,
  'id' | 'createdAt' | 'updatedAt'
>;

class CurationType
  extends Model<CurationTypeAttributes, CurationTypeCreationAttributes>
  implements ICurationType
{
  declare id: number;
  declare name: string;
  declare icon: string | null;
  declare color: string;
  declare abilities: number;
  declare sortOrder: number;
  declare createdAt: Date;
  declare updatedAt: Date;

  // Helper methods for bitwise abilities
  hasAbility(ability: number): boolean {
    return (this.abilities & ability) === ability;
  }

  addAbility(ability: number): void {
    this.abilities |= ability;
  }

  removeAbility(ability: number): void {
    this.abilities &= ~ability;
  }
}

CurationType.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    icon: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    color: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: '#ffffff',
    },
    abilities: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Bitwise permissions encoding for abilities',
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
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
    tableName: 'curation_types',
    timestamps: true,
  }
);

export default CurationType;
