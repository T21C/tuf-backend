import { Model, DataTypes, Optional } from 'sequelize';
import {
  ILevelAnnouncementQueue,
  LevelAnnouncementFacet,
  LevelAnnouncementKind,
  LevelAnnouncementQueueStatus,
  LevelAnnouncementSnapshot,
} from '@/server/interfaces/models/index.js';
import { getSequelizeForModelGroup } from '@/config/db.js';
import type Level from './Level.js';

const sequelize = getSequelizeForModelGroup('levels');

type LevelAnnouncementQueueAttributes = ILevelAnnouncementQueue;
type LevelAnnouncementQueueCreationAttributes = Optional<
  LevelAnnouncementQueueAttributes,
  'id' | 'pendingUniqueKey' | 'enqueuedBy' | 'announcedAt' | 'createdAt' | 'updatedAt'
>;

class LevelAnnouncementQueue
  extends Model<LevelAnnouncementQueueAttributes, LevelAnnouncementQueueCreationAttributes>
  implements ILevelAnnouncementQueue
{
  declare id: number;
  declare levelId: number;
  declare kind: LevelAnnouncementKind;
  declare facets: LevelAnnouncementFacet[];
  declare before: LevelAnnouncementSnapshot;
  declare after: LevelAnnouncementSnapshot;
  declare status: LevelAnnouncementQueueStatus;
  declare pendingUniqueKey: number | null;
  declare enqueuedBy: string | null;
  declare announcedAt: Date | null;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare level?: Level;
}

LevelAnnouncementQueue.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    levelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'levels', key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    kind: {
      type: DataTypes.ENUM('NEW', 'RERATE'),
      allowNull: false,
    },
    facets: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },
    before: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: {},
    },
    after: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: {},
    },
    status: {
      type: DataTypes.ENUM('PENDING', 'ANNOUNCED', 'SKIPPED'),
      allowNull: false,
      defaultValue: 'PENDING',
    },
    pendingUniqueKey: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    enqueuedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },
    announcedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'level_announcement_queue',
    indexes: [
      { fields: ['levelId'], name: 'idx_level_announcement_queue_level_id' },
      { fields: ['status'], name: 'idx_level_announcement_queue_status' },
      { fields: ['kind', 'status'], name: 'idx_level_announcement_queue_kind_status' },
      {
        fields: ['pendingUniqueKey'],
        unique: true,
        name: 'uniq_level_announcement_queue_pending_level',
      },
    ],
  },
);

export default LevelAnnouncementQueue;
