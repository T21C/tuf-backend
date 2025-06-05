import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import diskInfo from 'node-disk-info';
import { CDN_CONFIG, IMAGE_TYPES, ImageType } from '../config.js';
import { logger } from '../../services/LoggerService.js';
import CdnFile from '../../models/cdn/CdnFile.js';
import dotenv from 'dotenv';
dotenv.config();

const statAsync = promisify(fs.stat);
const readdirAsync = promisify(fs.readdir);

interface StorageDrive {
    drivePath: string;      // The actual drive path (e.g., "D:" or "/mnt/data")
    storagePath: string;    // The storage directory within the drive
    totalSpace: number;
    usedSpace: number;
    availableSpace: number;
    usagePercentage: number;
    isActive: boolean;
    filesystem: string;
    mounted: string;
}

export class StorageManager {
    private static instance: StorageManager;
    private drives: StorageDrive[] = [];
    private currentDriveIndex: number = 0;
    private readonly STORAGE_THRESHOLD = 90; // 90% usage threshold
    private readonly isWindows = process.platform === 'win32';
    private reservedDrive: string | null = null;
    private reservationCount: number = 0;

    constructor() {
        this.initializeDrives();
    }

    public static getInstance(): StorageManager {
        if (!StorageManager.instance) {
            StorageManager.instance = new StorageManager();
        }
        return StorageManager.instance;
    }

    private normalizeDrivePath(drivePath: string): string {
        // Remove trailing slashes and normalize
        const normalized = drivePath.replace(/[\/\\]$/, '');
        
        if (this.isWindows) {
            // For Windows, convert to uppercase and ensure drive letter format
            return normalized.toUpperCase();
        } else {
            // For Linux, just normalize the path
            return normalized;
        }
    }

    private getDrivePathFromStoragePath(storagePath: string): string {
        if (this.isWindows) {
            // For Windows, get the drive letter
            return path.parse(storagePath).root.replace(/[\/\\]$/, '');
        } else {
            // For Linux, get the mount point
            // If path is /mnt/data/storage, we want /mnt/data
            const parts = storagePath.split('/').filter(Boolean);
            if (parts[0] === 'mnt' && parts.length > 1) {
                return `/${parts[0]}/${parts[1]}`;
            }
            return '/'; // Default to root if not in /mnt
        }
    }

    private async initializeDrives() {
        try {
            const diskInfoList = diskInfo.getDiskInfoSync();
            logger.info('Disk info:', diskInfoList);
            
            const storagePaths = process.env.STORAGE_DRIVES?.split(',') || [process.env.USER_CDN_ROOT];
            
            if (!storagePaths) {
                throw new Error('STORAGE_DRIVES is not set');
            }
            logger.info(`Initializing storage paths: ${storagePaths}`);

            for (const storagePath of storagePaths) {
                try {
                    if (!storagePath) {
                        throw new Error('empty string in STORAGE_DRIVES');
                    }

                    // Get the drive/mount path from the storage path
                    const drivePath = this.getDrivePathFromStoragePath(storagePath);
                    const normalizedDrivePath = this.normalizeDrivePath(drivePath);
                    
                    // Find matching disk info for the drive
                    const disk = diskInfoList.find(d => 
                        this.normalizeDrivePath(d.mounted) === normalizedDrivePath
                    );

                    if (!disk) {
                        logger.warn(`No disk info found for drive ${drivePath} (normalized: ${normalizedDrivePath})`);
                        continue;
                    }

                    // Ensure storage directory exists
                    if (!fs.existsSync(storagePath)) {
                        fs.mkdirSync(storagePath, { recursive: true });
                        logger.info(`Created storage directory: ${storagePath}`);
                    }

                    // The values from node-disk-info are already in bytes
                    const totalSpace = disk.blocks;
                    const usedSpace = disk.used;
                    const availableSpace = disk.available;
                    const usagePercentage = parseFloat(disk.capacity);

                    this.drives.push({
                        drivePath,
                        storagePath,
                        totalSpace,
                        usedSpace,
                        availableSpace,
                        usagePercentage,
                        isActive: usagePercentage < this.STORAGE_THRESHOLD,
                        filesystem: disk.filesystem,
                        mounted: disk.mounted
                    });

                    logger.info(`Initialized storage path ${storagePath}`, { 
                        drive: drivePath,
                        filesystem: disk.filesystem,
                        mounted: disk.mounted,
                        totalSpace: this.formatBytes(totalSpace),
                        usedSpace: this.formatBytes(usedSpace),
                        availableSpace: this.formatBytes(availableSpace),
                        usagePercentage: `${usagePercentage}%`
                    });
                } catch (error) {
                    logger.error(`Failed to initialize storage path ${storagePath}:`, error);
                }
            }

            if (this.drives.length === 0) {
                throw new Error('No valid storage drives found');
            }

            // Sort drives by usage percentage
            this.drives.sort((a, b) => a.usagePercentage - b.usagePercentage);
        } catch (error) {
            logger.error('Failed to initialize storage drives:', error);
            throw error;
        }
    }

    private formatBytes(bytes: number): string {
        if (!this.isWindows) bytes *= 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        if (bytes === 0) return '0 Byte';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${Math.round(bytes / Math.pow(1024, i))} ${sizes[i]}`;
    }

    public async reserveDrive(): Promise<string> {
        if (this.reservedDrive) {
            this.reservationCount++;
            return this.reservedDrive;
        }

        // Update drive usage information
        await this.updateDriveUsage();

        // Sort drives by available space (descending) and filter out drives above threshold
        const availableDrives = this.drives
            .filter(drive => drive.usagePercentage < this.STORAGE_THRESHOLD)
            .sort((a, b) => b.availableSpace - a.availableSpace);

        if (availableDrives.length === 0) {
            throw new Error('No available storage drives below threshold');
        }

        // Get the drive with most available space
        const selectedDrive = availableDrives[0];
        
        this.reservedDrive = selectedDrive.storagePath;
        this.reservationCount = 1;

        logger.info(`Reserved drive: ${this.reservedDrive}`, {
            availableSpace: this.formatBytes(selectedDrive.availableSpace),
            usagePercentage: selectedDrive.usagePercentage,
            threshold: this.STORAGE_THRESHOLD
        });

        return this.reservedDrive;
    }

    public releaseDrive(): void {
        if (!this.reservedDrive) return;
        
        this.reservationCount--;
        if (this.reservationCount <= 0) {
            logger.info(`Released drive: ${this.reservedDrive}`);
            this.reservedDrive = null;
            this.reservationCount = 0;
        }
    }

    public async getNextAvailableDrive(): Promise<string> {
        if (this.reservedDrive) {
            return this.reservedDrive;
        }
        return this.reserveDrive();
    }

    private async updateDriveUsage() {
        try {
            const diskInfoList = diskInfo.getDiskInfoSync();
            
            for (const drive of this.drives) {
                const disk = diskInfoList.find(d => 
                    this.normalizeDrivePath(d.mounted) === this.normalizeDrivePath(drive.drivePath)
                );

                if (disk) {
                    // Convert Linux KiB to bytes if needed
                    const multiplier = this.isWindows ? 1 : 1024;
                    drive.usedSpace = disk.used * multiplier;
                    drive.availableSpace = disk.available * multiplier;
                    drive.usagePercentage = parseFloat(disk.capacity);
                    drive.isActive = drive.usagePercentage < this.STORAGE_THRESHOLD;
                }
            }
        } catch (error) {
            logger.error('Failed to update drive usage:', error);
        }
    }

    public async updateFileLocation(fileId: string, newPath: string) {
        try {
            const file = await CdnFile.findByPk(fileId);
            if (!file) {
                throw new Error(`File not found: ${fileId}`);
            }
            await file.update({ filePath: newPath });
        } catch (error) {
            logger.error(`Failed to update file location for ${fileId}:`, error);
            throw error;
        }
    }

    public async getFileLocation(fileId: string): Promise<string | null> {
        try {
            const file = await CdnFile.findByPk(fileId);
            return file?.filePath || null;
        } catch (error) {
            logger.error(`Failed to get file location for ${fileId}:`, error);
            return null;
        }
    }

    public getDrivesStatus(): StorageDrive[] {
        return this.drives.map(drive => ({
            ...drive,
            totalSpace: Math.round(drive.totalSpace / (1024 * 1024 * 1024)), // Convert to GB
            usedSpace: Math.round(drive.usedSpace / (1024 * 1024 * 1024)), // Convert to GB
            availableSpace: Math.round(drive.availableSpace / (1024 * 1024 * 1024)), // Convert to GB
            usagePercentage: Math.round(drive.usagePercentage * 100) / 100
        }));
    }

    // Utility function to safely delete files and directories
    public cleanupFiles(...paths: (string | undefined | null)[]): void {
        for (const rawPath of paths) {
            if (!rawPath) continue;
            const path = rawPath.replace(/\\/g, '/');

            try {
                // Validate path is not empty or root
                if (!path || path === '/' || path === '') {
                    logger.error('Invalid path provided for cleanup');
                    return;
                }

                // Check if path is within any of our storage paths
                const isWithinStorage = this.drives.some(drive => 
                    path.startsWith(drive.storagePath)
                );

                if (!isWithinStorage) {
                    logger.error('Attempted to delete file outside of storage directories', path);
                    return;
                }

                if (fs.existsSync(path)) {
                    const stats = fs.statSync(path);
                    if (stats.isDirectory()) {
                        fs.rmSync(path, { recursive: true, force: true });
                    } else {
                        fs.unlinkSync(path);
                    }
                }
            } catch (error) {
                logger.error(`Failed to cleanup path ${path}:`, error);
            }
        }
    }

    // Configure storage for regular files
    private storage = multer.diskStorage({
        destination: async (req, file, cb) => {
            try {
                const uploadDir = path.join(await this.getNextAvailableDrive(), 'temp');
                if (!fs.existsSync(uploadDir)) {
                    fs.mkdirSync(uploadDir, { recursive: true });
                }
                cb(null, uploadDir);
            } catch (error) {
                cb(error as Error, '');
            }
        },
        filename: (req, file, cb) => {
            const uniqueId = uuidv4();
            const ext = path.extname(file.originalname);
            cb(null, `${uniqueId}${ext}`);
        }
    });

    // Configure storage for images
    private imageStorage = multer.diskStorage({
        destination: async (req, file, cb) => {
            try {
                const imageType = (req.params.type || '').toUpperCase() as ImageType;
                if (!IMAGE_TYPES[imageType]) {
                    throw new Error('Invalid image type');
                }
                const uploadDir = path.join(await this.getNextAvailableDrive(), 'images', IMAGE_TYPES[imageType].name);
                if (!fs.existsSync(uploadDir)) {
                    fs.mkdirSync(uploadDir, { recursive: true });
                }
                cb(null, uploadDir);
            } catch (error) {
                cb(error as Error, '');
            }
        },
        filename: (req, file, cb) => {
            const uniqueId = uuidv4();
            const ext = path.extname(file.originalname);
            cb(null, `${uniqueId}${ext}`);
        }
    });

    public upload = multer({
        storage: this.storage,
        limits: {
            fileSize: CDN_CONFIG.maxFileSize
        }
    }).single('file');

    public imageUpload = multer({
        storage: this.imageStorage,
        limits: {
            fileSize: CDN_CONFIG.maxImageSize
        },
        fileFilter: (req, file, cb) => {
            const imageType = (req.params.type || '').toUpperCase() as ImageType;
            if (!IMAGE_TYPES[imageType]) {
                return cb(new Error('Invalid image type'));
            }
            
            const ext = path.extname(file.originalname).toLowerCase().slice(1) as typeof IMAGE_TYPES[ImageType]['formats'][number];
            if (!IMAGE_TYPES[imageType].formats.includes(ext)) {
                return cb(new Error(`Invalid file type. Allowed types: ${IMAGE_TYPES[imageType].formats.join(', ')}`));
            }
            
            cb(null, true);
        }
    }).single('image');
}

export const storageManager = StorageManager.getInstance();