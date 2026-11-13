import {DataTypes, Model, Optional} from 'sequelize';
import {getSequelizeForModelGroup} from '@/config/db.js';
import type Level from '@/models/levels/Level.js';

const sequelize = getSequelizeForModelGroup('curations');

export type CurationAnnouncementKind = 'NEW' | 'RERATE';
export type CurationAnnouncementQueueStatus = 'PENDING' | 'ANNOUNCED' | 'SKIPPED';

interface CurationAnnouncementQueueAttributes {
  id: number;
  levelId: number;
  kind: CurationAnnouncementKind;
  beforeTypeIds: number[];
  afterTypeIds: number[];
  status: CurationAnnouncementQueueStatus;
  pendingUniqueKey: number | null;
  enqueuedBy: string | null;
  announcedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type CurationAnnouncementQueueCreationAttributes = Optional<
  CurationAnnouncementQueueAttributes,
  'id' | 'pendingUniqueKey' | 'enqueuedBy' | 'announcedAt' | 'createdAt' | 'updatedAt'
>;

class CurationAnnouncementQueue
  extends Model<CurationAnnouncementQueueAttributes, CurationAnnouncementQueueCreationAttributes>
  implements CurationAnnouncementQueueAttributes
{
  declare id: number;
  declare levelId: number;
  declare kind: CurationAnnouncementKind;
  declare beforeTypeIds: number[];
  declare afterTypeIds: number[];
  declare status: CurationAnnouncementQueueStatus;
  declare pendingUniqueKey: number | null;
  declare enqueuedBy: string | null;
  declare announcedAt: Date | null;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare level?: Level;
}

CurationAnnouncementQueue.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    levelId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {model: 'levels', key: 'id'},
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    kind: {
      type: DataTypes.ENUM('NEW', 'RERATE'),
      allowNull: false,
    },
    beforeTypeIds: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },
    afterTypeIds: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
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
      references: {model: 'users', key: 'id'},
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
    tableName: 'curation_announcement_queue',
    indexes: [
      {fields: ['levelId'], name: 'idx_curation_announcement_queue_level_id'},
      {fields: ['kind', 'status'], name: 'idx_curation_announcement_queue_kind_status'},
      {
        fields: ['pendingUniqueKey'],
        unique: true,
        name: 'uniq_curation_announcement_queue_pending_level',
      },
    ],
  },
);

export default CurationAnnouncementQueue;
