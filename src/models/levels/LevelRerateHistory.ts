import { Model, DataTypes } from 'sequelize';
import Level from './Level.js';
import Difficulty from './Difficulty.js';
import User from '../auth/User.js';
import { getSequelizeForModelGroup } from '../../config/db.js';
const sequelize = getSequelizeForModelGroup('levels');

class LevelRerateHistory extends Model {
  declare id: number;
  declare levelId: number;
  declare previousDiffId: number;
  declare newDiffId: number;
  declare previousBaseScore: number;
  declare newBaseScore: number;
  declare reratedBy: string | null;
  declare createdAt: Date;
}

LevelRerateHistory.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    levelId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'levels', key: 'id' }
    },
    previousDiffId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'difficulties', key: 'id' }
    },
    newDiffId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'difficulties', key: 'id' }
    },
    oldLegacyValue: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null
    },
    newLegacyValue: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null
    },
    previousBaseScore: {
        type: DataTypes.FLOAT,
        defaultValue: 0,
        allowNull: false
    },
    newBaseScore: {
        type: DataTypes.FLOAT,
        defaultValue: 0,
        allowNull: false
    },
    reratedBy: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'users', key: 'id' }
    },
    createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
  },
  {
    sequelize,
    tableName: 'level_rerate_histories',
    timestamps: false,
    indexes: [
      {
        name: 'idx_rerate_unique_diff',
        unique: true,
        fields: ['levelId', 'previousDiffId', 'newDiffId', 'createdAt'],
      },
      {
        name: 'idx_rerate_unique_legacy',
        unique: true,
        fields: ['levelId', 'oldLegacyValue', 'newLegacyValue', 'createdAt'],
      },
    ],
  }
);

LevelRerateHistory.belongsTo(Level, { foreignKey: 'levelId' });
LevelRerateHistory.belongsTo(Difficulty, { foreignKey: 'previousDiffId', as: 'previousDifficulty' });
LevelRerateHistory.belongsTo(Difficulty, { foreignKey: 'newDiffId', as: 'newDifficulty' });
LevelRerateHistory.belongsTo(User, { foreignKey: 'reratedBy', as: 'user' });

export default LevelRerateHistory;
