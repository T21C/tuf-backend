import { Model, DataTypes } from 'sequelize';
import sequelize from '../../config/db.js';
import Level from './Level.js';
import Difficulty from './Difficulty.js';
import User from '../auth/User.js';

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
        allowNull: false,
        references: { model: 'difficulties', key: 'id' }
    },
    newDiffId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'difficulties', key: 'id' }
    },
    previousBaseScore: {
        type: DataTypes.FLOAT,
        allowNull: false
    },
    newBaseScore: {
        type: DataTypes.FLOAT,
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
  }
);

LevelRerateHistory.belongsTo(Level, { foreignKey: 'levelId' });
LevelRerateHistory.belongsTo(Difficulty, { foreignKey: 'previousDiffId', as: 'previousDifficulty' });
LevelRerateHistory.belongsTo(Difficulty, { foreignKey: 'newDiffId', as: 'newDifficulty' });
LevelRerateHistory.belongsTo(User, { foreignKey: 'reratedBy', as: 'user' });

export default LevelRerateHistory;
