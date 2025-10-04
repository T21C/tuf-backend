import {exec} from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { CronJob } from 'cron';
import config from '../config/backup.config.js';
import db from '../models/index.js';
import dotenv from 'dotenv';
import { logger } from './LoggerService.js';
import ElasticsearchService from './ElasticsearchService.js';
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
    if (!fsSync.existsSync(this.config.mysql.backupPath)) {
      fs.mkdir(this.config.mysql.backupPath, {recursive: true});
    }
    if (!fsSync.existsSync(this.config.files.backupPath)) {
      fs.mkdir(this.config.files.backupPath, {recursive: true});
    }
    logger.info(
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
      logger.info(`Restoring MySQL backup from: ${backupPath}`);
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
    });
  }

  async createFileBackup(type = 'manual') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `files-backup-${type}-${timestamp}.zip`;
    const filePath = path.join(this.config.files.backupPath, fileName);

    await fs.mkdir(this.config.files.backupPath, {recursive: true});

    let cmd: string;
    if (this.isWindows) {
      // Filter to only include cache directories and files
      const cachePaths = this.config.files.include
        .filter(path => path.includes('cache'))
        .map(file => file.replace(/\//g, '\\'));
      
      if (cachePaths.length === 0) {
        throw new Error('No cache paths found in include list');
      }
      
      const includeFiles = cachePaths.join(',');
      cmd = `powershell -Command "Compress-Archive -Path ${includeFiles} -DestinationPath '${filePath.replace(/\\/g, '\\')}' -Force"`;
    } else {
      // Linux command using zip
      // Filter to only include cache directories and files
      const cachePaths = this.config.files.include.filter(path => path.includes('cache'));
      
      if (cachePaths.length === 0) {
        throw new Error('No cache paths found in include list');
      }
      
      const includeFiles = cachePaths.join(' ');
      cmd = `zip -r "${filePath}" ${includeFiles}`;
    }

    return new Promise((resolve, reject) => {
      exec(cmd, {shell: this.isWindows ? 'cmd.exe' : '/bin/bash'}, error => {
        if (error) reject(error);
        else resolve(filePath);
      });
    });
  }

  async restoreFileBackup(backupPath: string) {
    let extractPath = path.join(this.config.files.backupPath, 'temp_restore');
    if (extractPath.startsWith('/')) {
      logger.warn('WARNING: Extract path is absolute, converting to relative:', extractPath);
      extractPath = path.join(process.cwd(), extractPath);
    }
    
    // Clean up any existing temp directory before extraction
    try {
      await fs.rm(extractPath, {recursive: true, force: true});
    } catch (error) {
      // Ignore errors if directory doesn't exist
    }
    
    // Ensure the extract path exists
    await fs.mkdir(extractPath, {recursive: true});
    
    try {
      // Check if the backup file exists
      try {
        await fs.access(backupPath);
      } catch (error) {
        throw new Error(`Backup file not found: ${backupPath}`);
      }
      
      let cmd: string;
      let sevenZipPath = '7z';
      
      if (this.isWindows) {
        // Use 7-Zip to extract
        cmd = `"${sevenZipPath}" x "${backupPath}" -o"${extractPath}" -y`;
      } else {
        // Linux command using unzip
        cmd = `unzip -o "${backupPath}" -d "${extractPath}"`;
      }

      await new Promise((resolve, reject) => {
        exec(cmd, {shell: this.isWindows ? 'cmd.exe' : '/bin/bash'}, (error, stdout, stderr) => {
          if (error) {
            reject(error);
          } else {
            resolve(true);
          }
        });
      });

      // Filter to only include cache directories
      const cachePaths = this.config.files.include.filter(path => path.includes('cache'));
      
      if (cachePaths.length === 0) {
        throw new Error('No cache paths found in include list');
      }

      // First, recursively create all necessary directories
      for (const destination of cachePaths) {
        // Handle wildcard patterns
        if (destination.includes('*')) {
          // For wildcard patterns, we need to find matching files in the extract path
          const baseDir = path.dirname(destination);
          
          // Create the destination directory
          await fs.mkdir(baseDir, {recursive: true});
          
          // Get all files in the extract path
          const extractFiles = await fs.readdir(extractPath);
          
          // For each file in the extract path, create corresponding directories
          for (const file of extractFiles) {
            const sourcePath = path.join(extractPath, file);
            
            // Check if it's a directory
            try {
              const stats = await fs.stat(sourcePath);
              if (stats.isDirectory()) {
                // Create corresponding directory in the destination
                const destDir = path.join(baseDir, file);
                await fs.mkdir(destDir, {recursive: true});
              }
            } catch (error) {
              // Ignore errors
            }
          }
        } else {
          // Handle regular directory paths
          const destDir = path.dirname(destination);
          
          // Ensure destination directory exists
          await fs.mkdir(destDir, {recursive: true});
          
          // Check if the source is a directory in the extract path
          const sourceDir = path.join(extractPath, path.basename(destination));
          
          try {
            const stats = await fs.stat(sourceDir);
            if (stats.isDirectory()) {
              // Create the destination directory
              await fs.mkdir(destination, {recursive: true});
            }
          } catch (error) {
            // Try to find the directory in a nested structure
            try {
              const extractContents = await fs.readdir(extractPath);
              for (const item of extractContents) {
                const itemPath = path.join(extractPath, item);
                try {
                  const itemStats = await fs.stat(itemPath);
                  if (itemStats.isDirectory()) {
                    const nestedPath = path.join(itemPath, path.basename(destination));
                    try {
                      const nestedStats = await fs.stat(nestedPath);
                      if (nestedStats.isDirectory()) {
                        // Create the destination directory
                        await fs.mkdir(destination, {recursive: true});
                        break;
                      }
                    } catch (nestedErr) {
                      // Not found in this nested location
                    }
                  }
                } catch (itemErr) {
                  // Skip this item
                }
              }
            } catch (listErr) {
              // Ignore errors
            }
          }
        }
      }

      // Now copy files back to their original locations
      for (const destination of cachePaths) {
        // Handle wildcard patterns
        if (destination.includes('*')) {
          // For wildcard patterns, we need to find matching files in the extract path
          const baseDir = path.dirname(destination);
          const fileNamePattern = path.basename(destination);
          
          // Get all files in the extract path
          const extractFiles = await fs.readdir(extractPath);
          
          // Filter files that match the pattern and exclude JSON files
          const matchingFiles = extractFiles.filter(file => {
            // Simple wildcard matching - can be improved for more complex patterns
            if (fileNamePattern === '*') return !file.endsWith('.json');
            if (fileNamePattern === '*.json') return file.endsWith('.json');
            return file === fileNamePattern && !file.endsWith('.json');
          });
          
          // Copy each matching file
          for (const file of matchingFiles) {
            const source = path.join(extractPath, file);
            const dest = path.join(baseDir, file);
            
            try {
              // Check if source is a directory
              const stats = await fs.stat(source);
              if (stats.isDirectory()) {
                // For directories, ensure the destination exists and copy recursively
                await fs.mkdir(dest, {recursive: true});
                await fs.cp(source, dest, {recursive: true});
              } else {
                // For files, remove existing and copy
                try {
                  await fs.rm(dest, {recursive: true, force: true});
                } catch (error) {
                  // Ignore errors if file doesn't exist
                }
                await fs.cp(source, dest, {recursive: true});
              }
            } catch (error) {
              // Ignore errors
            }
          }
        } else {
          // Handle regular directory paths
          const source = path.join(extractPath, path.basename(destination));
          const destDir = path.dirname(destination);

          try {
            // Check if source exists
            await fs.access(source);
            
            // Check if source is a directory
            const stats = await fs.stat(source);
            if (stats.isDirectory()) {
              // For directories, ensure the destination exists and copy recursively
              await fs.mkdir(destination, {recursive: true});
              
              // Remove existing files/directory if it exists
              try {
                await fs.rm(destination, {recursive: true, force: true});
              } catch (error) {
                // Ignore errors
              }
              
              // Copy the directory
              await fs.cp(source, destination, {recursive: true});
            } else {
              // For files, remove existing and copy
              try {
                await fs.rm(destination, {recursive: true, force: true});
              } catch (error) {
                // Ignore errors
              }
              
              // Copy the file
              await fs.cp(source, destination, {recursive: true});
            }
          } catch (error) {
            // Try to find the file/directory in a nested structure
            try {
              const extractContents = await fs.readdir(extractPath);
              for (const item of extractContents) {
                const itemPath = path.join(extractPath, item);
                try {
                  const itemStats = await fs.stat(itemPath);
                  if (itemStats.isDirectory()) {
                    const nestedPath = path.join(itemPath, path.basename(destination));
                    try {
                      const nestedStats = await fs.stat(nestedPath);
                      
                      if (nestedStats.isDirectory()) {
                        // For directories, ensure the destination exists and copy recursively
                        await fs.mkdir(destination, {recursive: true});
                        
                        // Remove existing files/directory if it exists
                        try {
                          await fs.rm(destination, {recursive: true, force: true});
                        } catch (rmError) {
                          // Ignore errors
                        }
                        
                        // Copy the directory
                        await fs.cp(nestedPath, destination, {recursive: true});
                      } else {
                        // For files, remove existing and copy
                        try {
                          await fs.rm(destination, {recursive: true, force: true});
                        } catch (rmError) {
                          // Ignore errors
                        }
                        
                        // Copy the file
                        await fs.cp(nestedPath, destination, {recursive: true});
                      }
                      break; // Found and processed, no need to check other items
                    } catch (nestedErr) {
                      // Not found in this nested location
                    }
                  }
                } catch (itemErr) {
                  // Skip this item
                }
              }
            } catch (listErr) {
              // Ignore errors
            }
          }
        }
      }

      logger.info(
        `Files backup restored successfully from: ${path.basename(backupPath)}`,
      );
    } catch (error) {
      logger.error('Error during backup restoration:', error);
      throw error;
    } finally {
      // Clean up temporary directory
      try {
        await fs.rm(extractPath, {recursive: true, force: true});
      } catch (error) {
        // Ignore errors if directory doesn't exist
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
      //logger.info(`Cleaned up ${removedCount} old ${type} MySQL backups`);
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
      //logger.info(`Cleaned up ${removedCount} old ${type} file backups`);
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

    // File backups
    Object.entries(this.config.files.schedule).forEach(([type, schedule]) => {
      const job = new CronJob(schedule, async () => {
        try {
          await this.createFileBackup(type);
          await this.cleanOldFileBackups(
            type as keyof typeof config.files.retention,
          );
        } catch (error) {
          logger.error(`Scheduled ${type} files backup failed:`, error);
        }
      });
      job.start();
    });
  }
}
