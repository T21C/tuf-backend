import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import CdnFile from '../../../models/cdn/CdnFile.js';
import { logger } from '../../../server/services/LoggerService.js';
import { storageManager } from './storageManager.js';
import sequelize from '../../../config/db.js';
import { Transaction } from 'sequelize';
import { safeTransactionRollback } from '../../../misc/utils/Utility.js';

export interface ImageValidationResult {
    isValid: boolean;
    errors: string[];
    warnings: string[];
    metadata: {
        width: number;
        height: number;
        format: string;
        size: number;
        hasAlpha: boolean;
        isAnimated: boolean;
    };
}

export async function validateImage(filePath: string, maxSize: number): Promise<ImageValidationResult> {
    const result: ImageValidationResult = {
        isValid: true,
        errors: [],
        warnings: [],
        metadata: {
            width: 0,
            height: 0,
            format: '',
            size: 0,
            hasAlpha: false,
            isAnimated: false
        }
    };

    try {
        // Check file size
        const stats = fs.statSync(filePath);
        result.metadata.size = stats.size;

        if (stats.size > maxSize) {
            result.isValid = false;
            result.errors.push(`File size exceeds maximum allowed size of ${maxSize / (1024 * 1024)}MB`);
        }

        // Get image metadata
        const metadata = await sharp(filePath).metadata();
        result.metadata.width = metadata.width || 0;
        result.metadata.height = metadata.height || 0;
        result.metadata.format = metadata.format || '';
        result.metadata.hasAlpha = metadata.hasAlpha || false;
        result.metadata.isAnimated = metadata.pages ? metadata.pages > 1 : false;

        // Validate dimensions
        if (result.metadata.width < 100 || result.metadata.height < 100) {
            result.isValid = false;
            result.errors.push('Image dimensions too small (minimum 100x100)');
        }

        if (result.metadata.width > 4096 || result.metadata.height > 4096) {
            result.warnings.push('Image dimensions very large (maximum 4096x4096)');
        }

        // Check for animated images
        if (result.metadata.isAnimated) {
            result.warnings.push('Animated images are not recommended');
        }

        // Validate format
        if (!['jpeg', 'jpg', 'png', 'webp'].includes(result.metadata.format)) {
            result.isValid = false;
            result.errors.push('Invalid image format. Allowed formats: JPEG, PNG, WebP');
        }

        // Check for potential malicious content
        const buffer = await fs.promises.readFile(filePath);
        const header = buffer.slice(0, 8).toString('hex');

        // Check for common image file signatures
        const validSignatures = {
            jpeg: 'ffd8ffe0',
            png: '89504e47',
            webp: '52494646'
        };

        const isValidSignature = Object.values(validSignatures).some(sig => header.startsWith(sig));
        if (!isValidSignature) {
            result.isValid = false;
            result.errors.push('Invalid image file signature');
        }

    } catch (error) {
        result.isValid = false;
        result.errors.push('Failed to validate image: ' + (error instanceof Error ? error.message : String(error)));
    }

    return result;
}

export async function moderateImage(fileId: string, approved: boolean, moderatorId: string, reason?: string) {
    let transaction: Transaction | undefined;

    try {
        // Start transaction
        transaction = await sequelize.transaction();

        const file = await CdnFile.findByPk(fileId, { transaction });
        if (!file) {
            await safeTransactionRollback(transaction);
            throw new Error('File not found');
        }

        if (approved) {
            // Move file from pending to approved directory
            const pendingPath = file.filePath;
            const approvedPath = file.filePath.replace('/pending/', '/approved/');

            // Create approved directory if it doesn't exist
            fs.mkdirSync(path.dirname(approvedPath), { recursive: true });

            // Move the file
            fs.renameSync(pendingPath, approvedPath);

            // Update database record within transaction
            await file.update({
                filePath: approvedPath,
                status: 'approved',
                moderatedAt: new Date(),
                moderatedBy: moderatorId,
                moderationReason: reason
            }, { transaction });

            // Commit the transaction
            await transaction.commit();

            logger.debug('Image approved successfully:', {
                fileId,
                pendingPath,
                approvedPath,
                moderatorId,
                timestamp: new Date().toISOString()
            });
        } else {
            // Store file path before deletion
            const filePath = file.filePath;

            // Delete the database record first within transaction
            await file.destroy({ transaction });

            // Commit the transaction
            await transaction.commit();

            // Clean up files from disk after successful database deletion
            try {
                storageManager.cleanupFiles(filePath);
                logger.debug('Image rejected and cleaned up successfully:', {
                    fileId,
                    filePath,
                    moderatorId,
                    timestamp: new Date().toISOString()
                });
            } catch (cleanupError) {
                logger.error('Failed to clean up rejected image files:', {
                    error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                    fileId,
                    filePath,
                    timestamp: new Date().toISOString()
                });
                // Don't fail the operation if file cleanup fails - database is already updated
            }
        }

        return true;
    } catch (error) {
        // Rollback transaction if it exists
        if (transaction) {
            try {
                await safeTransactionRollback(transaction);
            } catch (rollbackError) {
                logger.warn('Transaction rollback failed:', rollbackError);
            }
        }

        logger.error('Moderation error:', {
            error: error instanceof Error ? error.message : String(error),
            fileId,
            approved,
            moderatorId,
            timestamp: new Date().toISOString()
        });
        throw new Error('Failed to moderate image');
    }
}

export async function getPendingImages(page = 1, limit = 20) {
    try {
        const offset = (page - 1) * limit;

        const { count, rows } = await CdnFile.findAndCountAll({
            where: {
                status: 'pending'
            },
            order: [['createdAt', 'DESC']],
            limit,
            offset
        });

        return {
            total: count,
            page,
            limit,
            images: rows
        };
    } catch (error) {
        logger.error('Failed to fetch pending images:', error);
        throw new Error('Failed to fetch pending images');
    }
}
