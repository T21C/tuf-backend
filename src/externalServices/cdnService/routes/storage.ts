import { Router, Request, Response } from 'express';
import { logger } from '../../../server/services/LoggerService.js';
import { hybridStorageManager } from '../services/hybridStorageManager.js';
import { spacesStorage } from '../services/spacesStorage.js';

const router = Router();

// Get storage statistics
router.get('/stats', async (req: Request, res: Response) => {
    try {
        const stats = await hybridStorageManager.getStorageStats();
        res.json({
            success: true,
            stats
        });
    } catch (error) {
        logger.error('Failed to get storage statistics:', {
            error: error instanceof Error ? error.message : String(error)
        });
        res.status(500).json({
            error: 'Failed to get storage statistics'
        });
    }
});

// Get Spaces storage statistics
router.get('/spaces/stats', async (req: Request, res: Response) => {
    try {
        const stats = await spacesStorage.getStorageStats();
        res.json({
            success: true,
            stats
        });
    } catch (error) {
        logger.error('Failed to get Spaces storage statistics:', {
            error: error instanceof Error ? error.message : String(error)
        });
        res.status(500).json({
            error: 'Failed to get Spaces storage statistics'
        });
    }
});

// List files in Spaces
router.get('/spaces/files', async (req: Request, res: Response) => {
    try {
        const { prefix = '', maxKeys = 100 } = req.query;
        const files = await spacesStorage.listFiles(String(prefix), Number(maxKeys));

        res.json({
            success: true,
            files,
            count: files.length
        });
    } catch (error) {
        logger.error('Failed to list Spaces files:', {
            error: error instanceof Error ? error.message : String(error)
        });
        res.status(500).json({
            error: 'Failed to list Spaces files'
        });
    }
});

// Check if file exists in Spaces
router.get('/spaces/exists/:key(*)', async (req: Request, res: Response) => {
    try {
        const { key } = req.params;
        const exists = await spacesStorage.fileExists(key);

        res.json({
            success: true,
            key,
            exists
        });
    } catch (error) {
        logger.error('Failed to check file existence in Spaces:', {
            error: error instanceof Error ? error.message : String(error),
            key: req.params.key
        });
        res.status(500).json({
            error: 'Failed to check file existence'
        });
    }
});

// Get presigned URL for Spaces file
router.get('/spaces/url/:key(*)', async (req: Request, res: Response) => {
    try {
        const { key } = req.params;
        const url = await spacesStorage.getPresignedUrl(key);

        res.json({
            success: true,
            key,
            url
        });
    } catch (error) {
        logger.error('Failed to get presigned URL for Spaces file:', {
            error: error instanceof Error ? error.message : String(error),
            key: req.params.key
        });
        res.status(500).json({
            error: 'Failed to get presigned URL'
        });
    }
});

// Delete file from Spaces
router.delete('/spaces/:key(*)', async (req: Request, res: Response) => {
    try {
        const { key } = req.params;
        await spacesStorage.deleteFile(key);

        res.json({
            success: true,
            key,
            message: 'File deleted successfully'
        });
    } catch (error) {
        logger.error('Failed to delete file from Spaces:', {
            error: error instanceof Error ? error.message : String(error),
            key: req.params.key
        });
        res.status(500).json({
            error: 'Failed to delete file'
        });
    }
});

// Test Spaces connection
router.get('/spaces/test', async (req: Request, res: Response) => {
    try {
        // Try to list files with a test prefix
        const files = await spacesStorage.listFiles('test/', 1);

        res.json({
            success: true,
            message: 'Spaces connection successful',
            testResult: {
                canList: true,
                fileCount: files.length
            }
        });
    } catch (error) {
        logger.error('Spaces connection test failed:', {
            error: error instanceof Error ? error.message : String(error)
        });
        res.status(500).json({
            error: 'Spaces connection test failed',
            details: error instanceof Error ? error.message : String(error)
        });
    }
});

// Run storage type migration
router.post('/migrate-storage-types', async (req: Request, res: Response) => {
    try {
        const { migrateStorageTypes, verifyMigration } = await import('../scripts/migrateStorageTypes.js');

        logger.info('Starting storage type migration via API');

        // Run migration
        await migrateStorageTypes();

        // Run verification
        await verifyMigration();

        res.json({
            success: true,
            message: 'Storage type migration completed successfully'
        });
    } catch (error) {
        logger.error('Storage type migration failed:', {
            error: error instanceof Error ? error.message : String(error)
        });
        res.status(500).json({
            error: 'Storage type migration failed',
            details: error instanceof Error ? error.message : String(error)
        });
    }
});

export default router;
