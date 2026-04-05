import { Model, DataTypes } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
const sequelize = getSequelizeForModelGroup('curations');

/**
 * Junction: curation ↔ curation_types (tags).
 */
class CurationCurationType extends Model {
  declare curationId: number;
  declare typeId: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

CurationCurationType.init(
  {
    curationId: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: {
        model: 'curations',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    typeId: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      references: {
        model: 'curation_types',
        key: 'id',
      },
      onDelete: 'CASCADE',
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
    tableName: 'curation_curation_types',
    timestamps: true,
    indexes: [{ fields: ['typeId'] }],
  }
);

export default CurationCurationType;
