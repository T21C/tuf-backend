import { exec } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import cron from 'node-cron';
import config from '../config/backup.config.js';
import db from '../models/index.js';

export class BackupService {
  private config: typeof config;

  constructor() {
    this.config = config;
  }

  public getConfig() {
    return this.config;
  }

  async createMySQLBackup(type = 'manual') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `mysql-backup-${type}-${timestamp}.sql`;
    const filePath = path.join(this.config.mysql.backupPath, fileName);

    await fs.mkdir(this.config.mysql.backupPath, { recursive: true });

    const mysqlDumpPath = path.join(process.env.MYSQL_PATH || '', 'mysqldump.exe');
    const outputPath = filePath.replace(/\\/g, '/');

    const cmd = `"${mysqlDumpPath}" -h ${process.env.DB_HOST} -u ${process.env.DB_USER} \
      ${process.env.DB_PASSWORD ? `-p${process.env.DB_PASSWORD}` : ''} \
      ${process.env.DB_DATABASE} > "${outputPath}"`;

    return new Promise((resolve, reject) => {
      exec(cmd, { shell: 'cmd.exe' }, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve(filePath);
      });
    });
  }

  async restoreMySQLBackup(backupPath: string) {
    const mysqlPath = path.join(process.env.MYSQL_PATH || '', 'mysql.exe');
    const inputPath = backupPath.replace(/\\/g, '/');

    const cmd = `"${mysqlPath}" -h ${process.env.DB_HOST} -u ${process.env.DB_USER} \
      ${process.env.DB_PASSWORD ? `-p${process.env.DB_PASSWORD}` : ''} \
      ${process.env.DB_DATABASE} < "${inputPath}"`;

    return new Promise((resolve, reject) => {
      exec(cmd, { shell: 'cmd.exe' }, async (error, stdout, stderr) => {
        if (error) reject(error);
        else {
          // Force reload models after restore
          try {
            await db.sequelize.sync({ force: false });
            resolve(true);
          } catch (syncError) {
            reject(syncError);
          }
        }
      });
    });
  }

  async createFileBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `files-backup-${timestamp}.zip`;
    const filePath = path.join(this.config.files.backupPath, fileName);

    await fs.mkdir(this.config.files.backupPath, { recursive: true });

    const includeFiles = this.config.files.include
      .map(file => file.replace(/\//g, '\\'))
      .join(',');

    const cmd = `powershell -Command "Compress-Archive -Path ${includeFiles} -DestinationPath '${filePath.replace(/\\/g, '\\')}' -Force"`;

    return new Promise((resolve, reject) => {
      exec(cmd, { shell: 'cmd.exe' }, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve(filePath);
      });
    });
  }

  async restoreFileBackup(backupPath: string) {
    // Create a temporary extraction directory
    const extractPath = path.join(this.config.files.backupPath, 'temp_restore');
    await fs.mkdir(extractPath, { recursive: true });

    try {
      // Extract the backup
      const cmd = `powershell -Command "Expand-Archive -Path '${backupPath.replace(/\\/g, '\\')}' -DestinationPath '${extractPath.replace(/\\/g, '\\')}' -Force"`;
      
      await new Promise((resolve, reject) => {
        exec(cmd, { shell: 'cmd.exe' }, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve(true);
        });
      });

      // Copy files back to their original locations
      for (const destination of this.config.files.include) {
        const source = path.join(extractPath, path.basename(destination));
        const destDir = path.dirname(destination);
        
        // Ensure destination directory exists
        await fs.mkdir(destDir, { recursive: true });
        
        // Remove existing files/directory
        try {
          await fs.rm(destination, { recursive: true, force: true });
        } catch (error) {
          console.warn(`Warning: Could not remove existing files at ${destination}:`, error);
        }

        // Copy restored files
        await fs.cp(source, destination, { recursive: true });
      }
    } finally {
      // Clean up temporary directory
      try {
        await fs.rm(extractPath, { recursive: true, force: true });
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
    for (const file of typeFiles.slice(retention)) {
      await fs.unlink(path.join(backupDir, file));
    }
  }

  async initializeSchedules() {
    // MySQL backups
    Object.entries(this.config.mysql.schedule).forEach(([type, schedule]) => {
      cron.schedule(schedule, async () => {
        try {
          await this.createMySQLBackup(type);
          await this.cleanOldBackups(type as keyof typeof config.mysql.retention);
        } catch (error) {
          console.error(`Scheduled ${type} backup failed:`, error);
        }
      });
    });

    // File backups
    cron.schedule(this.config.files.schedule, async () => {
      try {
        await this.createFileBackup();
      } catch (error) {
        console.error('Scheduled file backup failed:', error);
      }
    });
  }
}
