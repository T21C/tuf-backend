import { Model, DataTypes, Optional } from 'sequelize';
import { getSequelizeForModelGroup } from '@/config/db.js';
import { logger } from '@/server/services/core/LoggerService.js';
import { safeRemoveUnderRoot } from '@/misc/utils/fs/fsSafeRemove.js';
import { WORKSPACE_ROOT } from '@/server/services/core/WorkspaceService.js';

const sequelize = getSequelizeForModelGroup('uploads');

export type UploadSessionStatus =
  | 'uploading'
  | 'assembling'
  | 'assembled'
  | 'failed'
  | 'cancelled';

export interface UploadSessionAttributes {
  id: string;
  kind: string;
  userId: string | null;
  /** NFC-normalized UTF-8 string as received in the JSON init body. */
  originalName: string;
  mimeType: string | null;
  declaredSize: number;
  /** Hex-encoded sha256 of the whole file, supplied at init; verified server-side during assembly. */
  declaredHash: string;
  chunkSize: number;
  totalChunks: number;
  /** Sorted array of received indices; ~4 KB for 10GB/12 MiB chunks. */
  receivedChunks: number[];
  status: UploadSessionStatus;
  assembledPath: string | null;
  assembledHash: string | null;
  /** Cached onAssembled return value for idempotent /complete. */
  result: Record<string, unknown> | null;
  /** Kind-specific metadata from init (e.g. { levelId }). */
  meta: Record<string, unknown> | null;
  /** Absolute path owned by this session — always under WORKSPACE_ROOT. */
  workspaceDir: string;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

type UploadSessionCreationAttributes = Optional<
  UploadSessionAttributes,
  'mimeType' | 'assembledPath' | 'assembledHash' | 'result' | 'meta' | 'errorMessage' | 'createdAt' | 'updatedAt' | 'status'
>;

class UploadSession
  extends Model<UploadSessionAttributes, UploadSessionCreationAttributes>
  implements UploadSessionAttributes
{
  declare id: string;
  declare kind: string;
  declare userId: string | null;
  declare originalName: string;
  declare mimeType: string | null;
  declare declaredSize: number;
  declare declaredHash: string;
  declare chunkSize: number;
  declare totalChunks: number;
  declare receivedChunks: number[];
  declare status: UploadSessionStatus;
  declare assembledPath: string | null;
  declare assembledHash: string | null;
  declare result: Record<string, unknown> | null;
  declare meta: Record<string, unknown> | null;
  declare workspaceDir: string;
  declare errorMessage: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
  declare expiresAt: Date;
}

UploadSession.init(
  {
    id: {
      type: DataTypes.CHAR(36),
      primaryKey: true,
      allowNull: false,
    },
    kind: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
      defaultValue: null,
    },
    originalName: {
      type: 'VARCHAR(512) CHARACTER SET utf8mb4',
      allowNull: false,
    },
    mimeType: {
      type: DataTypes.STRING(128),
      allowNull: true,
      defaultValue: null,
    },
    declaredSize: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    declaredHash: {
      type: DataTypes.CHAR(64),
      allowNull: false,
    },
    chunkSize: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    totalChunks: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    receivedChunks: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },
    status: {
      type: DataTypes.ENUM('uploading', 'assembling', 'assembled', 'failed', 'cancelled'),
      allowNull: false,
      defaultValue: 'uploading',
    },
    assembledPath: {
      type: DataTypes.STRING(1024),
      allowNull: true,
      defaultValue: null,
    },
    assembledHash: {
      type: DataTypes.CHAR(64),
      allowNull: true,
      defaultValue: null,
    },
    result: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },
    meta: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },
    workspaceDir: {
      type: DataTypes.STRING(1024),
      allowNull: false,
    },
    errorMessage: {
      type: DataTypes.STRING(2048),
      allowNull: true,
      defaultValue: null,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'upload_sessions',
    indexes: [
      { name: 'idx_us_kind_user', fields: ['kind', 'userId'] },
      { name: 'idx_us_status', fields: ['status'] },
      { name: 'idx_us_expires', fields: ['expiresAt'] },
    ],
    hooks: {
      /**
       * Belt + suspenders: the workspace lease normally deletes the dir in its own `finally`,
       * but if a caller destroys the row without going through the lease (e.g. expired-row
       * reaper) this hook guarantees the disk is cleaned up too.
       */
      async beforeDestroy(session) {
        const dir = session.workspaceDir;
        if (!dir) return;
        try {
          await safeRemoveUnderRoot(dir, WORKSPACE_ROOT);
        } catch (error) {
          logger.warn(`UploadSession beforeDestroy cleanup failed for ${dir}:`, error);
        }
      },
    },
  },
);

export default UploadSession;
