import { DataTypes } from 'sequelize';
import BaseModel from '../BaseModel.js';
import User from '../auth/User.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('admin');

class AuditLog extends BaseModel {
  declare userId: string | null;
  declare action: string;
  declare route: string;
  declare method: string;
  declare payload: any;
  declare result: any;
}

AuditLog.init(
  {
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: User,
        key: 'id',
      },
    },
    action: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    route: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    method: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    result: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: 'AuditLog',
    tableName: 'audit_logs',
    timestamps: true,
  },
);

AuditLog.belongsTo(User, { as: 'user', foreignKey: 'userId' });

export default AuditLog;
