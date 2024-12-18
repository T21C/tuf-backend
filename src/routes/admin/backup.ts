import { Router , Request, Response } from 'express';
import { Auth } from '../../middleware/auth.js';
import { BackupService } from '../../services/BackupService.js';
import fs from 'fs/promises';
import path from 'path';

const router: Router = Router();
const backupService = new BackupService();

// Initialize backup schedules
backupService.initializeSchedules().catch(console.error);

// Trigger manual backup
router.post('/create', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { type = 'manual', target = 'all' } = req.body;
    const results = [];

    if (target === 'all' || target === 'mysql') {
      const mysqlBackup = await backupService.createMySQLBackup(type);
      results.push({ type: 'mysql', path: mysqlBackup });
    }

    if (target === 'all' || target === 'files') {
      const fileBackup = await backupService.createFileBackup();
      results.push({ type: 'files', path: fileBackup });
    }

    res.json({ success: true, backups: results });
  } catch (error) {
    console.error('Backup creation failed:', error);
    res.status(500).json({ error: 'Backup creation failed' });
  }
});

// List available backups
router.get('/list', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const config = backupService.getConfig();
    const mysqlBackups = await fs.readdir(config.mysql.backupPath);
    const fileBackups = await fs.readdir(config.files.backupPath);

    // Get file stats for each backup
    const mysqlBackupStats = await Promise.all(
      mysqlBackups.map(async (filename) => {
        const stats = await fs.stat(path.join(config.mysql.backupPath, filename));
        return {
          filename,
          type: 'mysql',
          size: stats.size,
          created: stats.mtime
        };
      })
    );

    const fileBackupStats = await Promise.all(
      fileBackups.map(async (filename) => {
        const stats = await fs.stat(path.join(config.files.backupPath, filename));
        return {
          filename,
          type: 'files',
          size: stats.size,
          created: stats.mtime
        };
      })
    );

    res.json({
      mysql: mysqlBackupStats,
      files: fileBackupStats
    });
  } catch (error) {
    console.error('Failed to list backups:', error);
    res.status(500).json({ error: 'Failed to list backups' });
  }
});

// Restore backup
router.post('/restore/:type/:filename', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { type, filename } = req.params;
    const config = backupService.getConfig();
    
    if (!['mysql', 'files'].includes(type)) {
      return res.status(400).json({ error: 'Invalid backup type' });
    }

    const backupPath = type === 'mysql' ? config.mysql.backupPath : config.files.backupPath;
    const filePath = path.join(backupPath, filename);

    // Check if backup exists
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: 'Backup file not found' });
    }

    if (type === 'mysql') {
      await backupService.restoreMySQLBackup(filePath);
    } else {
      await backupService.restoreFileBackup(filePath);
    }

    return res.json({ success: true, message: 'Backup restored successfully' });
  } catch (error) {
    console.error('Failed to restore backup:', error);
    return res.status(500).json({ error: 'Failed to restore backup' });
  }
});

// Delete backup
router.delete('/delete/:type/:filename', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { type, filename } = req.params;
    const config = backupService.getConfig();
    
    if (!['mysql', 'files'].includes(type)) {
      return res.status(400).json({ error: 'Invalid backup type' });
    }

    const backupPath = type === 'mysql' ? config.mysql.backupPath : config.files.backupPath;
    const filePath = path.join(backupPath, filename);

    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: 'Backup file not found' });
    }

    await fs.unlink(filePath);
    return res.json({ success: true, message: 'Backup deleted successfully' });
  } catch (error) {
    console.error('Failed to delete backup:', error);
    return res.status(500).json({ error: 'Failed to delete backup' });
  }
});

export default router;