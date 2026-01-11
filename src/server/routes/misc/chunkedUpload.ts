import express, { Request, Response, Router } from 'express';
import { Auth } from '../../middleware/auth.js';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { logger } from '../../services/LoggerService.js';
import cors from 'cors';
import { corsOptions } from '../../../config/app.config.js';
import sequelize from '../../../config/db.js';
import { Transaction } from 'sequelize';
import Level from '../../../models/levels/Level.js';
import Creator from '../../../models/credits/Creator.js';
import LevelCredit from '../../../models/levels/LevelCredit.js';
import { permissionFlags } from '../../../config/constants.js';
import { hasFlag } from '../../../misc/utils/auth/permissionUtils.js';
import { checkLevelOwnership } from '../database/levels/modification.js';

const router: Router = express.Router();

// Update multer storage to use headers
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userId = req.user?.id;
    if (!userId) {
      return cb(new Error('User not authenticated'), '');
    }
    const chunkDir = path.join('uploads', 'chunks', userId);
    fs.mkdirSync(chunkDir, { recursive: true });
    cb(null, chunkDir);
  },
  filename: (req, file, cb) => {
    const fileId = req.headers['x-file-id'] as string;
    const chunkIndex = req.headers['x-chunk-index'] as string;


    if (!fileId || chunkIndex === undefined) {
      logger.error('Missing fileId or chunkIndex in headers', {
        headers: req.headers,
        file: {
          fieldname: file.fieldname,
          originalname: file.originalname
        }
      });
      return cb(new Error('Missing fileId or chunkIndex in headers'), '');
    }
    cb(null, `${fileId}_${chunkIndex}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 12 * 1024 * 1024 // 12MB to account for overhead
  }
});

// Store upload metadata with user information
const uploadMetadata = new Map();

// Track files that are currently being processed to prevent premature cleanup
const filesInUse = new Set<string>();

// Clean up old uploads periodically
setInterval(() => {
  const now = Date.now();
  for (const [fileId, metadata] of uploadMetadata.entries()) {
    if (now - metadata.createdAt > 24 * 60 * 60 * 1000) { // 24 hours
      const chunkDir = path.join('uploads', 'chunks', metadata.userId, fileId);
      fs.rmSync(chunkDir, { recursive: true, force: true });
      uploadMetadata.delete(fileId);
    }
  }
}, 60 * 60 * 1000); // Check every hour

// Add authentication to all routes
router.use(Auth.verified());

// Apply CORS with the shared options
router.use(cors(corsOptions));

router.get('/', (req: Request, res: Response) => {
  return res.json({ message: 'Chunked upload API is running' });
});

// Update the upload endpoint
router.post('/chunk', Auth.verified(), upload.single('chunk'), async (req: Request, res: Response) => {
  try {
    const fileId = req.headers['x-file-id'] as string;
    const chunkIndex = parseInt(req.headers['x-chunk-index'] as string);
    const totalChunks = parseInt(req.headers['x-total-chunks'] as string);
    const levelIdHeader = req.headers['x-level-id'] as string;
    const userId = req.user?.id;

    if (!fileId || isNaN(chunkIndex) || isNaN(totalChunks) || !userId) {
      logger.error('Missing required parameters in headers:', { headers: req.headers });
      return res.status(400).json({ error: 'Missing required parameters in headers' });
    }

    // If levelId is provided, check ownership
    if (levelIdHeader) {
      const levelId = parseInt(levelIdHeader);
      if (!isNaN(levelId)) {
        const transaction = await sequelize.transaction();
        try {
          const level = await Level.findByPk(levelId, { transaction });
          if (!level) {
            await transaction.rollback();
            return res.status(404).json({ error: 'Level not found' });
          }

          const {canEdit, errorMessage} = await checkLevelOwnership(levelId, req.user, transaction);
          if (!canEdit) {
              await transaction.rollback();
              return res.status(403).json({
                error: errorMessage,
              });
            }
          await transaction.commit();
        } catch (error) {
          await transaction.rollback();
          logger.error('Error checking level ownership:', error);
          return res.status(500).json({ error: 'Failed to verify level access' });
        }
      }
    }

    // Store metadata
    if (!uploadMetadata.has(fileId)) {
      uploadMetadata.set(fileId, {
        userId,
        totalChunks,
        receivedChunks: new Set()
      });
    }

    const metadata = uploadMetadata.get(fileId);
    if (!metadata) {
      return res.status(400).json({ error: 'Invalid file ID' });
    }

    metadata.receivedChunks.add(chunkIndex);

    // If all chunks received, assemble the file
    if (metadata.receivedChunks.size === metadata.totalChunks) {
      const assembledDir = path.join('uploads', 'assembled', userId);
      fs.mkdirSync(assembledDir, { recursive: true });
      const outputPath = path.join(assembledDir, `${fileId}.zip`);

      const writeStream = fs.createWriteStream(outputPath);
      
      // Mark file as in use
      filesInUse.add(fileId);

      try {
        // Handle client disconnect
        req.on('close', () => {
          if (!res.headersSent) {
            writeStream.destroy();
            filesInUse.delete(fileId);
          }
        });

        // Read and write chunks in order with proper error handling
        for (let i = 0; i < metadata.totalChunks; i++) {
          const chunkPath = path.join('uploads', 'chunks', userId, `${fileId}_${i}`);

          // Check if chunk exists before reading
          if (!fs.existsSync(chunkPath)) {
            throw new Error(`Chunk ${i} not found for file ${fileId}`);
          }

          const chunkBuffer = fs.readFileSync(chunkPath);
          
          // Handle backpressure and errors during write
          const writeSuccess = writeStream.write(chunkBuffer);
          if (!writeSuccess) {
            // Wait for drain event if buffer is full
            await new Promise<void>((resolve) => {
              writeStream.once('drain', resolve);
            });
          }
          
          // Remove chunk after writing
          fs.unlinkSync(chunkPath);
        }

        writeStream.end();

        // Wait for write to complete
        await new Promise<void>((resolve, reject) => {
          writeStream.on('finish', () => {
            filesInUse.delete(fileId);
            resolve();
          });
          writeStream.on('error', (err: NodeJS.ErrnoException) => {
            filesInUse.delete(fileId);
            // Don't reject ECONNRESET errors - they're client disconnects
            if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
              logger.warn('Client disconnected during file assembly:', {
                fileId,
                error: err.message
              });
              resolve(); // Resolve instead of reject to prevent crash
            } else {
              reject(err);
            }
          });
        });

        // Clean up metadata
        uploadMetadata.delete(fileId);

        // Check if response was already sent (client might have disconnected)
        if (!res.headersSent) {
          return res.json({
            message: 'File assembled successfully',
            fileId,
            path: outputPath
          });
        }
      } catch (error: any) {
        filesInUse.delete(fileId);
        // Clean up partial file on error
        try {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
          }
        } catch (cleanupError) {
          logger.warn('Failed to clean up partial assembled file:', cleanupError);
        }
        
        // Only send error if response hasn't been sent
        if (!res.headersSent) {
          throw error;
        } else {
          // Client disconnected, just log the error
          logger.warn('Error during file assembly after client disconnect:', error);
        }
      }
    }

    res.json({
      message: 'Chunk uploaded successfully',
      fileId,
      receivedChunks: metadata.receivedChunks.size,
      totalChunks: metadata.totalChunks
    });
  } catch (error) {
    logger.error('Chunk upload error:', error);
    res.status(500).json({ error: 'Failed to process upload' });
  }
  return
});

// Validate upload status
router.post('/validate', Auth.verified(), async (req: Request, res: Response) => {
  try {
    const { fileId, levelId } = req.body;

    if (!fileId) {
      return res.status(400).json({ error: 'Missing fileId' });
    }

    // If levelId is provided, check ownership
    if (levelId) {
      const parsedLevelId = parseInt(levelId);
      if (!isNaN(parsedLevelId)) {
        const transaction = await sequelize.transaction();
        try {
          const level = await Level.findByPk(parsedLevelId, { transaction });
          if (!level) {
            await transaction.rollback();
            return res.status(404).json({ error: 'Level not found' });
          }

          const {canEdit, errorMessage} = await checkLevelOwnership(parsedLevelId, req.user, transaction);
          if (!canEdit) {
            await transaction.rollback();
            return res.status(403).json({
              error: errorMessage,
            });
          }
          await transaction.commit();
        } catch (error) {
          await transaction.rollback();
          logger.error('Error checking level ownership:', error);
          return res.status(500).json({ error: 'Failed to verify level access' });
        }
      }
    }

    const metadata = uploadMetadata.get(fileId);
    if (!metadata) {
      // Check if file is already assembled
      const assembledPath = path.join('uploads', 'assembled', req.user!.id, `${fileId}.zip`);
      if (fs.existsSync(assembledPath)) {
        return res.json({
          success: true,
          fileName: path.basename(assembledPath),
          isComplete: true,
          filePath: assembledPath,
          fileSize: fs.statSync(assembledPath).size
        });
      }
      return res.status(404).json({ error: 'Upload not found' });
    }

    // Verify user owns this upload
    if (metadata.userId !== req.user?.id) {
      return res.status(403).json({ error: 'Unauthorized access to upload' });
    }

    // Check if all chunks exist
    const chunkDir = path.join('uploads', 'chunks', metadata.userId);
    const missingChunks = [];
    for (let i = 0; i < metadata.totalChunks; i++) {
      const chunkPath = path.join(chunkDir, `${fileId}_${i}`);
      if (!fs.existsSync(chunkPath)) {
        missingChunks.push(i);
      }
    }

    return res.json({
      success: true,
      fileName: metadata.fileName,
      chunksReceived: metadata.receivedChunks.size,
      totalChunks: metadata.totalChunks,
      isComplete: metadata.receivedChunks.size === metadata.totalChunks,
      missingChunks: missingChunks.length > 0 ? missingChunks : undefined,
      assembledPath: metadata.receivedChunks.size === metadata.totalChunks
        ? path.join('uploads', 'assembled', metadata.userId, `${fileId}.zip`)
        : undefined
    });

  } catch (error) {
    logger.error('Upload validation error:', error);
    return res.status(500).json({
      error: 'Failed to validate upload',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Add cleanup function
const cleanupUserUploads = async (userId: string, excludeFileId?: string) => {
  try {
    // Clean up chunks directory
    const chunksDir = path.join('uploads', 'chunks', userId);
    if (fs.existsSync(chunksDir)) {
      await fs.promises.rm(chunksDir, { recursive: true, force: true });
    }

    // Clean up assembled directory, but skip files that are in use or excluded
    const assembledDir = path.join('uploads', 'assembled', userId);
    if (fs.existsSync(assembledDir)) {
      const files = await fs.promises.readdir(assembledDir);
      for (const file of files) {
        // Extract fileId from filename (format: fileId.zip)
        const fileId = file.replace('.zip', '');
        
        // Skip if file is currently in use or is the excluded file
        if (filesInUse.has(fileId) || (excludeFileId && fileId === excludeFileId)) {
          logger.debug(`Skipping cleanup of file in use: ${fileId}`);
          continue;
        }
        
        try {
          await fs.promises.unlink(path.join(assembledDir, file));
        } catch (unlinkError: any) {
          // Ignore ENOENT errors - file might have been deleted already
          if (unlinkError.code !== 'ENOENT') {
            logger.warn(`Failed to delete assembled file ${file}:`, unlinkError);
          }
        }
      }
      
      // Remove directory if empty
      try {
        const remainingFiles = await fs.promises.readdir(assembledDir);
        if (remainingFiles.length === 0) {
          await fs.promises.rmdir(assembledDir);
        }
      } catch (rmdirError) {
        // Directory might not be empty or might have been removed
        logger.debug('Could not remove assembled directory:', rmdirError);
      }
    }

    // Clean up metadata (but keep entries for files in use)
    for (const [fileId, metadata] of uploadMetadata.entries()) {
      if (metadata.userId === userId && !filesInUse.has(fileId)) {
        uploadMetadata.delete(fileId);
      }
    }

    logger.debug(`Cleaned up uploads for user ${userId}`, {
      excludedFiles: excludeFileId ? [excludeFileId] : [],
      filesInUse: Array.from(filesInUse).filter(id => {
        const meta = uploadMetadata.get(id);
        return meta && meta.userId === userId;
      })
    });
  } catch (error) {
    logger.error('Failed to clean up user uploads:', error);
    throw error;
  }
};

// Add cleanup endpoint
router.post('/cleanup', Auth.verified(), async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    await cleanupUserUploads(userId);
    return res.json({ success: true, message: 'All uploads cleaned up successfully' });
  } catch (error) {
    logger.error('Cleanup error:', error);
    return res.status(500).json({
      error: 'Failed to clean up uploads',
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Export the cleanup function
export { cleanupUserUploads };

export default router;
