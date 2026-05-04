import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '@/config/db.js';

export type HealthLatencyComponent = 'database' | 'main_server' | 'cdn';

export interface HealthLatencySampleAttributes {
  id: number;
  component: HealthLatencyComponent;
  recordedAt: Date;
  durationMs: number | null;
  ok: boolean;
}

type Creation = Optional<HealthLatencySampleAttributes, 'id'>;

class HealthLatencySample
  extends Model<HealthLatencySampleAttributes, Creation>
  implements HealthLatencySampleAttributes
{
  declare id: number;
  declare component: HealthLatencyComponent;
  declare recordedAt: Date;
  declare durationMs: number | null;
  declare ok: boolean;
}

HealthLatencySample.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    component: {
      type: DataTypes.ENUM('database', 'main_server', 'cdn'),
      allowNull: false,
    },
    recordedAt: {
      type: DataTypes.DATE(6),
      allowNull: false,
      field: 'recorded_at',
    },
    durationMs: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
      field: 'duration_ms',
    },
    ok: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
    },
  },
  {
    sequelize,
    modelName: 'HealthLatencySample',
    tableName: 'health_latency_samples',
    timestamps: false,
    underscored: true,
  },
);

export default HealthLatencySample;
