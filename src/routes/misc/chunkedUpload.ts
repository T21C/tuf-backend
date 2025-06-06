import express, { Request, Response, Router } from 'express';
import { Auth } from '../../middleware/auth.js';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { logger } from '../../services/LoggerService.js';
import cors from 'cors';
import { corsOptions } from '../../config/app.config.js';

const router: Router = express.Router();

// Ensure upload directories exist
const ensureUploadDirs = (userId: string) => {
  const chunkDir = path.join('uploads', 'chunks', userId);
  const assembledDir = path.join('uploads', 'assembled', userId);
  
  if (!fs.existsSync(chunkDir)) {
    fs.mkdirSync(chunkDir, { recursive: true });
  }
  if (!fs.existsSync(assembledDir)) {
    fs.mkdirSync(assembledDir, { recursive: true });
  }
};

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
router.use(Auth.superAdmin());

// Apply CORS with the shared options
router.use(cors(corsOptions));

router.get('/', (req: Request, res: Response) => {
  return res.json({ message: 'Chunked upload API is running' });
});

// Update the upload endpoint
router.post('/chunk', Auth.superAdmin(), upload.single('chunk'), async (req: Request, res: Response) => {
  try {
    const fileId = req.headers['x-file-id'] as string;
    const chunkIndex = parseInt(req.headers['x-chunk-index'] as string);
    const totalChunks = parseInt(req.headers['x-total-chunks'] as string);
    const userId = req.user?.id;

    if (!fileId || isNaN(chunkIndex) || isNaN(totalChunks) || !userId) {
      logger.error('Missing required parameters in headers:', { headers: req.headers });
      return res.status(400).json({ error: 'Missing required parameters in headers' });
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
      
      // Read and write chunks in order
      for (let i = 0; i < metadata.totalChunks; i++) {
        const chunkPath = path.join('uploads', 'chunks', userId, `${fileId}_${i}`);
        
        const chunkBuffer = fs.readFileSync(chunkPath);
        writeStream.write(chunkBuffer);
        // Remove chunk after writing
        fs.unlinkSync(chunkPath);
      }
      
      writeStream.end();
      
      // Wait for write to complete
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', () => resolve());
        writeStream.on('error', (err) => reject(err));
      });

      // Clean up metadata
      uploadMetadata.delete(fileId);
      
      return res.json({
        message: 'File assembled successfully',
        fileId,
        path: outputPath
      });
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
router.post('/validate', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const { fileId } = req.body;
    
    if (!fileId) {
      return res.status(400).json({ error: 'Missing fileId' });
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
const cleanupUserUploads = async (userId: string) => {
  try {
    // Clean up chunks directory
    const chunksDir = path.join('uploads', 'chunks', userId);
    if (fs.existsSync(chunksDir)) {
      await fs.promises.rm(chunksDir, { recursive: true, force: true });
    }

    // Clean up assembled directory
    const assembledDir = path.join('uploads', 'assembled', userId);
    if (fs.existsSync(assembledDir)) {
      await fs.promises.rm(assembledDir, { recursive: true, force: true });
    }

    // Clean up metadata
    for (const [fileId, metadata] of uploadMetadata.entries()) {
      if (metadata.userId === userId) {
        uploadMetadata.delete(fileId);
      }
    }

    logger.info(`Cleaned up all uploads for user ${userId}`);
  } catch (error) {
    logger.error('Failed to clean up user uploads:', error);
    throw error;
  }
};

// Add cleanup endpoint
router.post('/cleanup', Auth.superAdmin(), async (req: Request, res: Response) => {
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