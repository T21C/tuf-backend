import {DataTypes, Model} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';

interface ReceiptAttributes {
  runId: string;
  ownerId: string;
  passId: number;
  requestHash: string;
  validation: object;
}

class AutoSubmissionReceipt extends Model<ReceiptAttributes> implements ReceiptAttributes {
  declare runId: string;
  declare ownerId: string;
  declare passId: number;
  declare requestHash: string;
  declare validation: object;
}

AutoSubmissionReceipt.init({
  runId: {type: DataTypes.UUID, primaryKey: true, allowNull: false},
  ownerId: {type: DataTypes.UUID, allowNull: false},
  passId: {type: DataTypes.INTEGER, allowNull: false, unique: true},
  requestHash: {type: DataTypes.STRING(64), allowNull: false},
  validation: {type: DataTypes.JSON, allowNull: false},
}, {
  sequelize: getSequelizeForModelGroup('submissions'),
  tableName: 'auto_submission_receipts', timestamps: true,
});

export default AutoSubmissionReceipt;
