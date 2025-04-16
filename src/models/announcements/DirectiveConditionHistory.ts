import { Model, DataTypes } from 'sequelize';
import sequelize from '../../config/db.js';
import Level from '../levels/Level.js';

class DirectiveConditionHistory extends Model {
  declare id: number;
  declare levelId: number;
  declare conditionHash: string;
  declare createdAt: Date;
  declare updatedAt: Date;
}

DirectiveConditionHistory.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    levelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'levels',
        key: 'id',
      },
    },
    conditionHash: {
      type: DataTypes.STRING,
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
    tableName: 'directive_condition_history',
    indexes: [
      {
        unique: true,
        fields: ['levelId', 'conditionHash'],
      },
    ],
  }
);

// Set up association
DirectiveConditionHistory.belongsTo(Level, {
  foreignKey: 'levelId',
  as: 'level',
});

export default DirectiveConditionHistory; 