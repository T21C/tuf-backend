import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { CDN_CONFIG } from '../config.js';
import CdnFile from '../../models/cdn/CdnFile.js';
import { logger } from '../../services/LoggerService.js';
import { cleanupFiles } from './storage.js';

// Helper function to create directory entries
async function createDirectoryEntry(zipFileId: string, relativePath: string, parentId: string | null = null) {
    const dirPath = path.join(CDN_CONFIG.root, relativePath);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    return await CdnFile.create({
        originalName: path.basename(relativePath),
        filePath: dirPath,
        fileType: '',
        fileSize: 0,
        mimeType: 'inode/directory',
        isDirectory: true,
        relativePath: relativePath,
        zipFileId: zipFileId,
        parentId: parentId
    });
}

export async function processZipFile(zipFilePath: string, zipFileId: string) {
    let tempDir: string | null = null;
    let permanentDir: string | null = null;
    
    try {
        // Create temporary directory for extraction
        tempDir = path.join(
            CDN_CONFIG.root,
            'temp',
            'extract_' + Date.now() + '_' + Math.random().toString(36).substring(7)
        );
        fs.mkdirSync(tempDir, { recursive: true });

        // Create permanent directory for the zip contents
        permanentDir = path.join(CDN_CONFIG.root, 'extracted', zipFileId);
        fs.mkdirSync(permanentDir, { recursive: true });

        const zip = new AdmZip(zipFilePath);
        const zipEntries = zip.getEntries();
        const directoryMap = new Map<string, string>(); // relativePath -> directoryId

        // First pass: Create all directories
        for (const entry of zipEntries) {
            if (entry.isDirectory) {
                const relativePath = entry.entryName.replace(/\/$/, '');
                const parentPath = path.dirname(relativePath);
                const parentId = parentPath === '.' ? null : directoryMap.get(parentPath);
                
                const dir = await createDirectoryEntry(zipFileId, relativePath, parentId);
                directoryMap.set(relativePath, dir.id);
            }
        }

        // Second pass: Extract files
        for (const entry of zipEntries) {
            if (!entry.isDirectory) {
                const relativePath = entry.entryName;
                const parentPath = path.dirname(relativePath);
                const parentId = parentPath === '.' ? null : directoryMap.get(parentPath);
                
                // Extract to temp directory first
                const tempPath = path.join(tempDir, relativePath);
                zip.extractEntryTo(entry, path.dirname(tempPath), false, true);

                // Move to permanent location
                const permanentPath = path.join(permanentDir, relativePath);
                fs.mkdirSync(path.dirname(permanentPath), { recursive: true });
                fs.copyFileSync(tempPath, permanentPath);

                // Determine MIME type
                let mimeType = 'application/octet-stream';
                const ext = path.extname(entry.name).toLowerCase();
                if (['.jpg', '.jpeg'].includes(ext)) mimeType = 'image/jpeg';
                else if (ext === '.png') mimeType = 'image/png';
                else if (ext === '.gif') mimeType = 'image/gif';
                else if (ext === '.pdf') mimeType = 'application/pdf';
                else if (ext === '.txt') mimeType = 'text/plain';
                else if (ext === '.json') mimeType = 'application/json';

                await CdnFile.create({
                    originalName: entry.name,
                    filePath: permanentPath,
                    fileType: ext,
                    fileSize: entry.header.size,
                    mimeType: mimeType,
                    relativePath: relativePath,
                    zipFileId: zipFileId,
                    parentId: parentId
                });
            }
        }
    } catch (error) {
        logger.error('Error processing zip file:', error);
        // Clean up permanent directory if something went wrong
        if (permanentDir) {
            cleanupFiles(permanentDir);
        }
        throw new Error('Failed to process zip file');
    } finally {
        // Clean up temporary directory
        cleanupFiles(tempDir);
    }
}

export async function repackZipFile(zipFileId: string) {
    let tempZipPath: string | null = null;
    
    try {
        const zipFile = await CdnFile.findByPk(zipFileId);
        if (!zipFile) {
            throw new Error('Original zip file not found');
        }

        // Get all files associated with this zip
        const extractedFiles = await CdnFile.findAll({
            where: {
                zipFileId: zipFileId,
                isDirectory: false
            }
        });

        if (extractedFiles.length === 0) {
            throw new Error('No files found to repack');
        }

        tempZipPath = path.join(
            CDN_CONFIG.root,
            'temp',
            'repacked_' + Date.now() + '_' + Math.random().toString(36).substring(7) + '.zip'
        );

        const zip = new AdmZip();
        
        // Add each file to the zip maintaining its relative path
        for (const file of extractedFiles) {
            if (file.relativePath && fs.existsSync(file.filePath)) {
                zip.addLocalFile(file.filePath, path.dirname(file.relativePath), path.basename(file.relativePath));
            }
        }

        zip.writeZip(tempZipPath);
        return tempZipPath;
    } catch (error) {
        logger.error('Error repacking zip file:', error);
        cleanupFiles(tempZipPath);
        throw new Error('Failed to repack zip file');
    }
} 