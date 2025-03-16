import {exec} from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import cron from 'node-cron';
import config from '../config/backup.config.js';
import db from '../models/index.js';
import dotenv from 'dotenv';
dotenv.config();

const DATABASE_NAME =
  process.env.NODE_ENV === 'staging'
    ? process.env.DB_STAGING_DATABASE
    : process.env.DB_DATABASE;

export class BackupService {
  private config: typeof config;
  private isWindows: boolean;

  constructor() {
    this.config = config;
    this.isWindows = process.env.OS === 'Windows_NT';
    console.log(
      `BackupService initialized for ${this.isWindows ? 'Windows' : 'Linux'}`,
    );
  }

  public getConfig() {
    return this.config;
  }

  async createMySQLBackup(type = 'manual') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `mysql-backup-${type}-${timestamp}.sql`;
    const filePath = path.join(this.config.mysql.backupPath, fileName);

    await fs.mkdir(this.config.mysql.backupPath, {recursive: true});

    let cmd: string;
    if (this.isWindows) {
      const mysqlDumpPath = path.join(
        process.env.MYSQL_PATH || '',
        'mysqldump.exe',
      );
      const outputPath = filePath.replace(/\\/g, '/');
      cmd = `"${mysqlDumpPath}" -h ${process.env.DB_HOST} -u ${process.env.DB_USER} ${process.env.DB_PASSWORD ? `-p${process.env.DB_PASSWORD}` : ''} ${DATABASE_NAME} > "${outputPath}"`;
    } else {
      // Linux command
      cmd = `mysqldump -h ${process.env.DB_HOST} -u ${process.env.DB_USER} ${process.env.DB_PASSWORD ? `-p${process.env.DB_PASSWORD}` : ''} ${DATABASE_NAME} > "${filePath}"`;
    }

    return new Promise((resolve, reject) => {
      exec(cmd, {shell: this.isWindows ? 'cmd.exe' : '/bin/bash'}, error => {
        if (error) reject(error);
        else resolve(filePath);
      });
    });
  }

  async restoreMySQLBackup(backupPath: string) {
    let cmd: string;
    if (this.isWindows) {
      const mysqlPath = path.join(process.env.MYSQL_PATH || '', 'mysql.exe');
      const inputPath = backupPath.replace(/\\/g, '/');
      cmd = `"${mysqlPath}" -h ${process.env.DB_HOST} -u ${process.env.DB_USER} ${process.env.DB_PASSWORD ? `-p${process.env.DB_PASSWORD}` : ''} ${DATABASE_NAME} < "${inputPath}"`;
    } else {
      // Linux command
      cmd = `mysql -h ${process.env.DB_HOST} -u ${process.env.DB_USER} ${process.env.DB_PASSWORD ? `-p${process.env.DB_PASSWORD}` : ''} ${DATABASE_NAME} < "${backupPath}"`;
    }

    return new Promise((resolve, reject) => {
      exec(
        cmd,
        {shell: this.isWindows ? 'cmd.exe' : '/bin/bash'},
        async error => {
          if (error) reject(error);
          else {
            try {
              await db.sequelize.sync({force: false});
              console.log(
                `MySQL backup restored successfully from: ${path.basename(backupPath)}`,
              );
              resolve(true);
            } catch (syncError) {
              reject(syncError);
            }
          }
        },
      );
    });
  }

  async createFileBackup(type = 'manual') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `files-backup-${type}-${timestamp}.zip`;
    const filePath = path.join(this.config.files.backupPath, fileName);

    await fs.mkdir(this.config.files.backupPath, {recursive: true});

    let cmd: string;
    if (this.isWindows) {
      const includeFiles = this.config.files.include
        .map(file => file.replace(/\//g, '\\'))
        .join(',');
      cmd = `powershell -Command "Compress-Archive -Path ${includeFiles} -DestinationPath '${filePath.replace(/\\/g, '\\')}' -Force"`;
    } else {
      // Linux command using tar
      const includeFiles = this.config.files.include.join(' ');
      cmd = `tar -czf "${filePath}" ${includeFiles}`;
    }

    return new Promise((resolve, reject) => {
      exec(cmd, {shell: this.isWindows ? 'cmd.exe' : '/bin/bash'}, error => {
        if (error) reject(error);
        else resolve(filePath);
      });
    });
  }

  async restoreFileBackup(backupPath: string) {
    const extractPath = path.join(this.config.files.backupPath, 'temp_restore');
    await fs.mkdir(extractPath, {recursive: true});

    try {
      let cmd: string;
      if (this.isWindows) {
        cmd = `powershell -Command "Expand-Archive -Path '${backupPath.replace(/\\/g, '\\')}' -DestinationPath '${extractPath.replace(/\\/g, '\\')}' -Force"`;
      } else {
        // Linux command
        cmd = `tar -xzf "${backupPath}" -C "${extractPath}"`;
      }

      await new Promise((resolve, reject) => {
        exec(cmd, {shell: this.isWindows ? 'cmd.exe' : '/bin/bash'}, error => {
          if (error) reject(error);
          else resolve(true);
        });
      });

      // Copy files back to their original locations
      for (const destination of this.config.files.include) {
        const source = path.join(extractPath, path.basename(destination));
        const destDir = path.dirname(destination);

        // Ensure destination directory exists
        await fs.mkdir(destDir, {recursive: true});

        // Remove existing files/directory
        try {
          await fs.rm(destination, {recursive: true, force: true});
        } catch (error) {
          console.warn(
            `Warning: Could not remove existing files at ${destination}:`,
            error,
          );
        }

        // Copy restored files
        await fs.cp(source, destination, {recursive: true});
      }

      console.log(
        `Files backup restored successfully from: ${path.basename(backupPath)}`,
      );
    } finally {
      // Clean up temporary directory
      try {
        await fs.rm(extractPath, {recursive: true, force: true});
      } catch (error) {
        console.warn('Warning: Could not clean up temporary directory:', error);
      }
    }
  }

  async cleanOldBackups(type: keyof typeof config.mysql.retention) {
    const retention = this.config.mysql.retention[type];
    if (!retention) return;

    const backupDir = this.config.mysql.backupPath;
    const files = await fs.readdir(backupDir);
    const typeFiles = files.filter(f => f.includes(`mysql-backup-${type}`));

    // Sort by date, newest first
    typeFiles.sort().reverse();

    // Remove files beyond retention period
    let removedCount = 0;
    for (const file of typeFiles.slice(retention)) {
      await fs.unlink(path.join(backupDir, file));
      removedCount++;
    }

    if (removedCount > 0) {
      console.log(`Cleaned up ${removedCount} old ${type} MySQL backups`);
    }
  }

  async cleanOldFileBackups(type: keyof typeof config.files.retention) {
    const retention = this.config.files.retention[type];
    if (!retention) return;

    const backupDir = this.config.files.backupPath;
    const files = await fs.readdir(backupDir);
    const typeFiles = files.filter(f => f.includes(`files-backup-${type}-`));

    // Sort by date, newest first
    typeFiles.sort().reverse();

    // Remove files beyond retention period
    let removedCount = 0;
    for (const file of typeFiles.slice(retention)) {
      await fs.unlink(path.join(backupDir, file));
      removedCount++;
    }

    if (removedCount > 0) {
      console.log(`Cleaned up ${removedCount} old ${type} file backups`);
    }
  }

  async uploadBackup(
    file: Express.Multer.File,
    type: 'mysql' | 'files',
  ): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const originalExt = path.extname(file.originalname);
    const newFileName = `Upload_${type}-backup-${timestamp}${originalExt}`;
    const targetDir =
      type === 'mysql'
        ? this.config.mysql.backupPath
        : this.config.files.backupPath;
    const targetPath = path.join(targetDir, newFileName);

    try {
      // Ensure backup directory exists
      await fs.mkdir(targetDir, {recursive: true});

      // Copy the file instead of renaming
      await fs.copyFile(file.path, targetPath);
      
      // Delete the temporary file after successful copy
      await fs.unlink(file.path);

      return newFileName;
    } catch (error) {
      // Clean up if something goes wrong
      try {
        await fs.unlink(file.path);
      } catch (cleanupError) {
        console.warn('Failed to clean up temporary file:', cleanupError);
      }
      throw new Error(`Failed to upload backup: ${(error as Error).message}`);
    }
  }

  async initializeSchedules() {
    // MySQL backups
    Object.entries(this.config.mysql.schedule).forEach(([type, schedule]) => {
      cron.schedule(schedule, async () => {
        try {
          await this.createMySQLBackup(type);
          await this.cleanOldBackups(
            type as keyof typeof config.mysql.retention,
          );
        } catch (error) {
          console.error(`Scheduled ${type} MySQL backup failed:`, error);
        }
      });
    });

    // File backups
    Object.entries(this.config.files.schedule).forEach(([type, schedule]) => {
      cron.schedule(schedule, async () => {
        try {
          await this.createFileBackup(type);
          await this.cleanOldFileBackups(
            type as keyof typeof config.files.retention,
          );
        } catch (error) {
          console.error(`Scheduled ${type} files backup failed:`, error);
        }
      });
    });
  }
}
