import { Model, DataTypes } from 'sequelize';
import sequelize from '../config/db.js';
import AnnouncementDirective from './AnnouncementDirective.js';

class DirectiveConditionHistory extends Model {
  declare id: number;
  declare directiveId: number;
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
    directiveId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'announcement_directives',
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
        fields: ['directiveId', 'conditionHash'],
      },
    ],
  }
);

// Set up association
DirectiveConditionHistory.belongsTo(AnnouncementDirective, {
  foreignKey: 'directiveId',
  as: 'directive',
});

export default DirectiveConditionHistory; 