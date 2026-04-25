import { DataTypes, Model, Optional } from 'sequelize';
import sequelize from '@/config/db.js';

export interface OutboxEventAttributes {
  id: number;
  eventType: string;
  aggregate: string;
  aggregateId: string;
  payload: unknown;
  dedupKey: string | null;
  createdAt: Date;
  publishedAt: Date | null;
  attempts: number;
}

type OutboxCreation = Optional<
  OutboxEventAttributes,
  'id' | 'createdAt' | 'publishedAt' | 'attempts'
>;

class OutboxEvent extends Model<OutboxEventAttributes, OutboxCreation> implements OutboxEventAttributes {
  declare id: number;
  declare eventType: string;
  declare aggregate: string;
  declare aggregateId: string;
  declare payload: unknown;
  declare dedupKey: string | null;
  declare createdAt: Date;
  declare publishedAt: Date | null;
  declare attempts: number;
}

OutboxEvent.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    eventType: {
      type: DataTypes.STRING(128),
      allowNull: false,
    },
    aggregate: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    aggregateId: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    dedupKey: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE(6),
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    publishedAt: {
      type: DataTypes.DATE(6),
      allowNull: true,
    },
    attempts: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    modelName: 'OutboxEvent',
    tableName: 'outbox',
    timestamps: false,
    underscored: true,
  },
);

export default OutboxEvent;
