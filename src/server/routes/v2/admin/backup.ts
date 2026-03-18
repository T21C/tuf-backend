import {Router, Request, Response} from 'express';
import {Auth} from '@/server/middleware/auth.js';
import {ApiDoc} from '@/server/middleware/apiDoc.js';
import { standardErrorResponses, standardErrorResponses400500, standardErrorResponses500 } from '@/server/schemas/v2/admin/index.js';
import {BackupService} from '@/server/services/BackupService.js';
import multer from 'multer';
import os from 'os';
import { logger } from '@/server/services/LoggerService.js';

const router: Router = Router();
const backupService = new BackupService();

// Configure multer for file uploads
const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 1024 * 1024 * 500, // 500MB limit
    files: 1,
  },
});

// Initialize backup schedules
backupService.initializeSchedules().catch(logger.error);

// Validate upload credentials
router.head(
  '/upload/validate',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'headAdminBackupUploadValidate',
    summary: 'Validate MySQL backup upload',
    description: 'Validate MySQL backup upload credentials. Super admin password.',
    tags: ['Admin', 'Backup'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'Valid' }, ...standardErrorResponses400500 },
  }),
  async (_req: Request, res: Response) => {
    try {
      return res.status(200).end();
    } catch (error) {
      logger.error('Upload validation failed:', error);
      return res.status(500).json({error: 'Upload validation failed'});
    }
  },
);

// Upload backup
router.post(
  '/upload',
  Auth.superAdminPassword(),
  upload.single('backup'),
  ApiDoc({
    operationId: 'postAdminBackupUpload',
    summary: 'Upload MySQL backup',
    description: 'Upload MySQL backup file. Multipart: backup. Super admin password.',
    tags: ['Admin', 'Backup'],
    security: ['bearerAuth'],
    requestBody: { description: 'multipart backup file', schema: { type: 'object' }, required: true },
    responses: { 200: { description: 'Uploaded' }, ...standardErrorResponses400500 },
  }),
  async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({error: 'No file uploaded'});
      }

      const newFileName = await backupService.uploadBackup(req.file);

      return res.json({
        success: true,
        message: 'Backup uploaded successfully',
        fileName: newFileName,
      });
    } catch (error) {
      logger.error('Failed to upload backup:', error);
      return res.status(500).json({error: 'Failed to upload backup'});
    }
  },
);

// Trigger manual backup
router.post(
  '/create',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'postAdminBackupCreate',
    summary: 'Create MySQL backup',
    description: 'Trigger manual MySQL backup. Body: type?. Super admin password.',
    tags: ['Admin', 'Backup'],
    security: ['bearerAuth'],
    requestBody: { description: 'type (optional)', schema: { type: 'object', properties: { type: { type: 'string' } } }, required: false },
    responses: { 200: { description: 'Backups created' }, ...standardErrorResponses500 },
  }),
  async (req: Request, res: Response) => {
    try {
      const {type = 'manual'} = req.body;
      const mysqlBackup = await backupService.createMySQLBackup(type);
      res.json({success: true, backups: [{type: 'mysql', path: mysqlBackup}]});
    } catch (error) {
      logger.error('Backup creation failed:', error);
      res.status(500).json({error: 'Backup creation failed'});
    }
  },
);

// List available backups
router.get(
  '/list',
  Auth.superAdmin(),
  ApiDoc({
    operationId: 'getAdminBackupList',
    summary: 'List MySQL backups',
    description: 'List available MySQL backups. Super admin.',
    tags: ['Admin', 'Backup'],
    security: ['bearerAuth'],
    responses: { 200: { description: 'Backup list' }, ...standardErrorResponses500 },
  }),
  async (_req: Request, res: Response) => {
  try {
    const mysqlBackups = await backupService.listMySQLBackups();
    res.json({mysql: mysqlBackups});
  } catch (error) {
    logger.error('Failed to list backups:', error);
    res.status(500).json({error: 'Failed to list backups'});
  }
  }
);

// Restore backup
router.post(
  '/restore/:filename',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'postAdminBackupRestore',
    summary: 'Restore MySQL backup',
    description: 'Restore MySQL backup by filename. Super admin password.',
    tags: ['Admin', 'Backup'],
    security: ['bearerAuth'],
    params: { filename: { schema: { type: 'string' } } },
    responses: { 200: { description: 'Restored' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    try {
      const {filename} = req.params;
      const backupExists = await backupService.hasBackup(filename);
      if (!backupExists) {
        return res.status(404).json({error: 'Backup file not found'});
      }
      await backupService.restoreMySQLBackup(filename);

      return res.json({success: true, message: 'Backup restored successfully'});
    } catch (error) {
      logger.error('Failed to restore backup:', error);
      return res.status(500).json({error: 'Failed to restore backup'});
    }
  },
);

// Delete backup
router.delete(
  '/delete/:filename',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'deleteAdminBackup',
    summary: 'Delete MySQL backup',
    description: 'Delete MySQL backup file. Super admin password.',
    tags: ['Admin', 'Backup'],
    security: ['bearerAuth'],
    params: { filename: { schema: { type: 'string' } } },
    responses: { 200: { description: 'Deleted' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    try {
      const {filename} = req.params;
      const backupExists = await backupService.hasBackup(filename);
      if (!backupExists) {
        return res.status(404).json({error: 'Backup file not found'});
      }

      await backupService.deleteBackup(filename);
      return res.json({success: true, message: 'Backup deleted successfully'});
    } catch (error) {
      logger.error('Failed to delete backup:', error);
      return res.status(500).json({error: 'Failed to delete backup'});
    }
  },
);

// Rename backup
router.post(
  '/rename/:filename',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'postAdminBackupRename',
    summary: 'Rename MySQL backup',
    description: 'Rename MySQL backup file. Body: newName. Super admin password.',
    tags: ['Admin', 'Backup'],
    security: ['bearerAuth'],
    params: { filename: { schema: { type: 'string' } } },
    requestBody: { description: 'newName', schema: { type: 'object', properties: { newName: { type: 'string' } }, required: ['newName'] }, required: true },
    responses: { 200: { description: 'Renamed' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    try {
      const {filename} = req.params;
      const {newName} = req.body;

      const hasSource = await backupService.hasBackup(filename);
      if (!hasSource) {
        return res.status(404).json({error: 'Backup file not found'});
      }

      const targetExists = await backupService.hasBackup(newName);
      if (targetExists) {
        return res
          .status(400)
          .json({error: 'A backup with this name already exists'});
      }

      await backupService.renameBackup(filename, newName);
      return res.json({
        success: true,
        message: 'Backup renamed successfully',
        newName,
      });
    } catch (error) {
      logger.error('Failed to rename backup:', error);
      return res.status(500).json({error: 'Failed to rename backup'});
    }
  },
);

// Download backup
router.get(
  '/download/:filename',
  Auth.superAdminPassword(),
  ApiDoc({
    operationId: 'getAdminBackupDownload',
    summary: 'Download MySQL backup',
    description: 'Stream MySQL backup file download. Super admin password.',
    tags: ['Admin', 'Backup'],
    security: ['bearerAuth'],
    params: { filename: { schema: { type: 'string' } } },
    responses: { 200: { description: 'File stream' }, ...standardErrorResponses },
  }),
  async (req: Request, res: Response) => {
    try {
      const {filename} = req.params;
      const backupExists = await backupService.hasBackup(filename);
      if (!backupExists) {
        return res.status(404).json({error: 'Backup file not found'});
      }

      // Set appropriate headers to prevent double compression
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/sql');

      const fileStream = await backupService.getBackupReadStream(filename);
      fileStream.pipe(res);
      return;
    } catch (error) {
      logger.error('Failed to download backup:', error);
      return res.status(500).json({error: 'Failed to download backup'});
    }
  },
);

export default router;
