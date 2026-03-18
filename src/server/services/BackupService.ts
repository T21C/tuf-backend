import {exec} from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import AWS from 'aws-sdk';
import os from 'os';
import { pipeline } from 'stream/promises';
import { CronJob } from 'cron';
import config from '@/config/backup.config.js';
import dotenv from 'dotenv';
import { logger } from './LoggerService.js';
import ElasticsearchService from './ElasticsearchService.js';
dotenv.config();

const DATABASE_NAME =
  process.env.NODE_ENV === 'staging'
    ? process.env.DB_STAGING_DATABASE
    : process.env.DB_DATABASE;

type BackupType = 'mysql';

interface BackupStorageEntry {
  filename: string;
  type: BackupType;
  size: number;
  created: Date;
}

export class BackupService {
  private config: typeof config;
  private isWindows: boolean;
  private backupS3: AWS.S3;
  private backupBucket: string;
  private backupRegion: string;

  constructor() {
    this.config = config;
    this.isWindows = process.env.OS === 'Windows_NT';
    const backupEnv = this.loadBackupEnvConfig();
    this.backupBucket = backupEnv.bucket;
    this.backupRegion = backupEnv.region;
    this.backupS3 = new AWS.S3({
      accessKeyId: backupEnv.accessKeyId,
      secretAccessKey: backupEnv.secretAccessKey,
      endpoint: backupEnv.endpoint,
      region: backupEnv.region,
      s3ForcePathStyle: true,
      signatureVersion: 'v4',
    });
    logger.info(
      `BackupService initialized for ${this.isWindows ? 'Windows' : 'Linux'}`,
    );
    logger.info('Backup storage mode', {
      useRemoteStorage: true,
      bucket: this.backupBucket,
      region: this.backupRegion,
    });
  }

  public getConfig() {
    return this.config;
  }

  private loadBackupEnvConfig(): {
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    region: string;
    endpoint: string;
  } {
    const accessKeyId =
      process.env.DIGITAL_OCEAN_BACKUP_KEY || process.env.DIGITAL_OCEAN_KEY || '';
    const secretAccessKey =
      process.env.DIGITAL_OCEAN_BACKUP_SECRET || process.env.DIGITAL_OCEAN_SECRET || '';
    const bucket =
      process.env.DIGITAL_OCEAN_BACKUP_BUCKET || process.env.DIGITAL_OCEAN_BUCKET || '';
    const region =
      process.env.DIGITAL_OCEAN_BACKUP_REGION || process.env.DIGITAL_OCEAN_REGION || 'sgp1';
    const endpoint = `https://${region}.digitaloceanspaces.com`;

    if (!accessKeyId || !secretAccessKey || !bucket) {
      throw new Error(
        'Missing required backup Spaces env vars: DIGITAL_OCEAN_BACKUP_KEY (or DIGITAL_OCEAN_KEY), DIGITAL_OCEAN_BACKUP_SECRET (or DIGITAL_OCEAN_SECRET), DIGITAL_OCEAN_BACKUP_BUCKET (or DIGITAL_OCEAN_BUCKET)',
      );
    }

    return {
      accessKeyId,
      secretAccessKey,
      bucket,
      region,
      endpoint,
    };
  }

  private normalizeBackupFilename(filename: string): string {
    const normalized = path.posix.basename(
      String(filename || '').trim().replace(/\\/g, '/'),
    );
    if (!normalized || normalized === '.' || normalized === '..') {
      throw new Error('Invalid backup filename');
    }
    return normalized;
  }

  private getBackupPrefix(): string {
    if (process.env.NODE_ENV === 'development') {
      return 'backups/mysql-dev/';
    }
    return 'backups/mysql/';
  }

  private getBackupKey(filename: string): string {
    return `${this.getBackupPrefix()}${this.normalizeBackupFilename(filename)}`;
  }

  private getBackupContentType(filename: string): string {
    return filename.endsWith('.sql') ? 'application/sql' : 'application/zip';
  }

  private getTempBackupPath(filename: string): string {
    return path.join(os.tmpdir(), 'tuf-backup-temp', this.normalizeBackupFilename(filename));
  }

  private async storeBackupFromLocalPath(
    localPath: string,
    filename: string,
  ): Promise<string> {
    const key = this.getBackupKey(filename);
    await this.backupS3
      .upload({
        Bucket: this.backupBucket,
        Key: key,
        Body: fsSync.createReadStream(localPath),
        ContentType: this.getBackupContentType(filename),
        ACL: 'private',
      })
      .promise();

    await fs.rm(localPath);
    return key;
  }

  private async resolveBackupPathForRestore(
    backupPathOrFilename: string,
  ): Promise<{path: string; isTemp: boolean}> {
    const filename = this.normalizeBackupFilename(backupPathOrFilename);
    const key = this.getBackupKey(filename);
    const tempDir = path.join(os.tmpdir(), 'tuf-backup-restore', 'mysql');
    const tempPath = path.join(tempDir, filename);

    await fs.mkdir(tempDir, {recursive: true});
    const readStream = this.backupS3
      .getObject({Bucket: this.backupBucket, Key: key})
      .createReadStream();
    const writeStream = fsSync.createWriteStream(tempPath);

    await pipeline(readStream, writeStream);
    return {path: tempPath, isTemp: true};
  }

  private async listBackups(): Promise<BackupStorageEntry[]> {
    const prefix = this.getBackupPrefix();
    const result = await this.backupS3
      .listObjectsV2({
        Bucket: this.backupBucket,
        Prefix: prefix,
        MaxKeys: 1000,
      })
      .promise();

    return (result.Contents || [])
      .filter(item => item.Key && !item.Key.endsWith('/'))
      .map(item => {
        const key = item.Key || '';
        const filename = key.replace(prefix, '');
        return {
          filename,
          type: 'mysql',
          size: item.Size || 0,
          created: item.LastModified || new Date(0),
        };
      });
  }

  public async listMySQLBackups(): Promise<BackupStorageEntry[]> {
    return this.listBackups();
  }

  public async hasBackup(filename: string): Promise<boolean> {
    const normalized = this.normalizeBackupFilename(filename);
    try {
      await this.backupS3
        .headObject({
          Bucket: this.backupBucket,
          Key: this.getBackupKey(normalized),
        })
        .promise();
      return true;
    } catch (error) {
      if ((error as any)?.statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  public async deleteBackup(filename: string): Promise<void> {
    const normalized = this.normalizeBackupFilename(filename);
    await this.backupS3
      .deleteObject({
        Bucket: this.backupBucket,
        Key: this.getBackupKey(normalized),
      })
      .promise();
  }

  public async renameBackup(
    filename: string,
    newName: string,
  ): Promise<void> {
    const sourceName = this.normalizeBackupFilename(filename);
    const targetName = this.normalizeBackupFilename(newName);

    const sourceKey = this.getBackupKey(sourceName);
    const targetKey = this.getBackupKey(targetName);

    await this.backupS3
      .copyObject({
        Bucket: this.backupBucket,
        CopySource: `${this.backupBucket}/${sourceKey}`,
        Key: targetKey,
        ACL: 'private',
      })
      .promise();

    await this.backupS3
      .deleteObject({
        Bucket: this.backupBucket,
        Key: sourceKey,
      })
      .promise();
  }

  public async getBackupReadStream(
    filename: string,
  ): Promise<NodeJS.ReadableStream> {
    const normalized = this.normalizeBackupFilename(filename);
    return this.backupS3
      .getObject({
        Bucket: this.backupBucket,
        Key: this.getBackupKey(normalized),
      })
      .createReadStream();
  }

  async createMySQLBackup(type = 'manual') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `mysql-backup-${type}-${timestamp}.sql`;
    const filePath = this.getTempBackupPath(fileName);

    await fs.mkdir(path.dirname(filePath), {recursive: true});

    let cmd: string;
    const dumpFlags = '--single-transaction --quick';
    if (this.isWindows) {
      const mysqlDumpPath = path.join(
        process.env.MYSQL_PATH || '',
        'mysqldump.exe',
      );
      const outputPath = filePath.replace(/\\/g, '/');
      cmd = `"${mysqlDumpPath}" ${dumpFlags} -h ${process.env.DB_HOST} -u ${process.env.DB_USER} ${process.env.DB_PASSWORD ? `-p${process.env.DB_PASSWORD}` : ''} ${DATABASE_NAME} > "${outputPath}"`;
    } else {
      cmd = `mysqldump ${dumpFlags} -h ${process.env.DB_HOST} -u ${process.env.DB_USER} ${process.env.DB_PASSWORD ? `-p${process.env.DB_PASSWORD}` : ''} ${DATABASE_NAME} > "${filePath}"`;
    }

    return new Promise((resolve, reject) => {
      exec(cmd, {shell: this.isWindows ? 'cmd.exe' : '/bin/bash'}, async error => {
        if (error) {
          reject(error);
          return;
        }

        try {
          const savedPath = await this.storeBackupFromLocalPath(
            filePath,
            fileName,
          );
          resolve(savedPath);
        } catch (storeError) {
          reject(storeError);
        }
      });
    });
  }

  async restoreMySQLBackup(backupPath: string) {
    const resolvedBackup = await this.resolveBackupPathForRestore(backupPath);
    let cmd: string;
    if (this.isWindows) {
      const mysqlPath = path.join(process.env.MYSQL_PATH || '', 'mysql.exe');
      const inputPath = resolvedBackup.path.replace(/\\/g, '/');
      cmd = `"${mysqlPath}" -h ${process.env.DB_HOST} -u ${process.env.DB_USER} ${process.env.DB_PASSWORD ? `-p${process.env.DB_PASSWORD}` : ''} ${DATABASE_NAME} < "${inputPath}"`;
    } else {
      // Linux command
      cmd = `mysql -h ${process.env.DB_HOST} -u ${process.env.DB_USER} ${process.env.DB_PASSWORD ? `-p${process.env.DB_PASSWORD}` : ''} ${DATABASE_NAME} < "${resolvedBackup.path}"`;
    }

    return new Promise((resolve, reject) => {
      logger.info(`Restoring MySQL backup from: ${resolvedBackup.path}`);
      exec(
        cmd,
        {shell: this.isWindows ? 'cmd.exe' : '/bin/bash'},
        async error => {
          if (error) reject(error);
          else {
            try {
              logger.info(
                `MySQL backup restored successfully from: ${path.basename(backupPath)}`,
              );
              await Promise.all([
                ElasticsearchService.getInstance().reindexLevels(),
                ElasticsearchService.getInstance().reindexPasses(),
              ]);
              logger.info('Elasticsearch reindexed successfully');
              resolve(true);
            } catch (syncError) {
              reject(syncError);
            }
          }
        },
      );
    }).finally(async () => {
      if (resolvedBackup.isTemp) {
        await fs.rm(resolvedBackup.path);
      }
    });
  }

  async cleanOldBackups(type: keyof typeof config.mysql.retention) {
    const retention = this.config.mysql.retention[type];
    if (!retention) return;

    const mysqlBackups = await this.listBackups();
    const typeFiles = mysqlBackups
      .filter(file => file.filename.includes(`mysql-backup-${type}`))
      .map(file => file.filename);

    // Sort by date, newest first
    typeFiles.sort().reverse();

    // Remove files beyond retention period
    let removedCount = 0;
    for (const file of typeFiles.slice(retention)) {
      await this.deleteBackup(file);
      removedCount++;
    }

    if (removedCount > 0) {
      //logger.info(`Cleaned up ${removedCount} old ${type} MySQL backups`);
    }
  }

  async uploadBackup(file: Express.Multer.File): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const originalExt = path.extname(file.originalname);
    const newFileName = `Upload_mysql-backup-${timestamp}${originalExt}`;
    try {
      await this.storeBackupFromLocalPath(file.path, newFileName);
      if (fsSync.existsSync(file.path)) {
        await fs.unlink(file.path);
      }
      return newFileName;
    } catch (error) {
      // Clean up if something goes wrong
      try {
        await fs.unlink(file.path);
      } catch (cleanupError) {
        logger.warn('Failed to clean up temporary file:', cleanupError);
      }
      throw new Error(`Failed to upload backup: ${(error as Error).message}`);
    }
  }

  async initializeSchedules() {
    // MySQL backups
    Object.entries(this.config.mysql.schedule).forEach(([type, schedule]) => {
      const job = new CronJob(schedule, async () => {
        try {
          await this.createMySQLBackup(type);
          await this.cleanOldBackups(
            type as keyof typeof config.mysql.retention,
          );
        } catch (error) {
          logger.error(`Scheduled ${type} MySQL backup failed:`, error);
        }
      });
      job.start();
    });
  }
}
