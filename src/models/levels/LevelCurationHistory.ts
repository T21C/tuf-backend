import { Model, DataTypes } from 'sequelize';
import Level from './Level.js';
import User from '@/models/auth/User.js';
import { getSequelizeForModelGroup } from '@/config/db.js';

const sequelize = getSequelizeForModelGroup('levels');

function readTypeIds(value: unknown): number[] {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of raw) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

class LevelCurationHistory extends Model {
  declare id: number;
  declare levelId: number;
  declare previousTypeIds: number[];
  declare newTypeIds: number[];
  declare changedBy: string | null;
  declare createdAt: Date;
}

LevelCurationHistory.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    levelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'levels', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    previousTypeIds: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
      get() {
        return readTypeIds(this.getDataValue('previousTypeIds'));
      },
    },
    newTypeIds: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
      get() {
        return readTypeIds(this.getDataValue('newTypeIds'));
      },
    },
    changedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'level_curation_histories',
    timestamps: false,
    indexes: [
      {
        name: 'idx_level_curation_histories_level_created',
        fields: ['levelId', 'createdAt'],
      },
    ],
  },
);

LevelCurationHistory.belongsTo(Level, { foreignKey: 'levelId' });
LevelCurationHistory.belongsTo(User, { foreignKey: 'changedBy', as: 'user' });

export default LevelCurationHistory;
