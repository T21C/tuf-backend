import {DataTypes, Model} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type {LevelRequestStatus, LevelRequestType} from '@/misc/utils/data/levelRequestValidation.js';

const sequelize = getSequelizeForModelGroup('levels');

export type LevelRequestPayload = Record<string, unknown>;

class LevelRequest extends Model {
  declare id: number;
  declare type: LevelRequestType;
  declare levelId: number;
  declare requesterUserId: string;
  declare status: LevelRequestStatus;
  declare reason: string;
  declare publicNote: string | null;
  declare internalNote: string | null;
  declare payload: LevelRequestPayload;
  declare linkedRatingId: number | null;
  declare immediateSettle: boolean;
  declare discordMessageUrl: string | null;
  declare discordPostError: string | null;
  declare discordThreadClosed: boolean;
  declare resolvedAt: Date | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

LevelRequest.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    type: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    levelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    requesterUserId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: 'pending',
    },
    reason: {
      type: DataTypes.STRING(1000),
      allowNull: false,
      defaultValue: '',
    },
    publicNote: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    internalNote: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    linkedRatingId: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    immediateSettle: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    discordMessageUrl: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    discordPostError: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    discordThreadClosed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    resolvedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'level_requests',
    indexes: [
      {fields: ['levelId', 'type', 'status']},
      {fields: ['requesterUserId', 'createdAt']},
      {fields: ['linkedRatingId']},
      {fields: ['status', 'createdAt']},
    ],
  },
);

export default LevelRequest;
