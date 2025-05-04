import { Router, Request, Response } from 'express';
import { Auth } from '../../middleware/auth.js';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { spawn, ChildProcess } from 'child_process';
import { logger } from '../../services/LoggerService.js';

const router: Router = Router();

// Store the remote profiling process
let remoteProfilingProcess: ChildProcess | null = null;

// Get the profiles directory
const getProfilesDir = () => {
    const p =path.join(process.cwd(), 'profiles');
    logger.info(p);
   return  p;
};

// Ensure profiles directory exists
const ensureProfilesDir = async () => {
  const profilesDir = getProfilesDir();
  try {
    await fs.access(profilesDir);
  } catch {
    await fs.mkdir(profilesDir, { recursive: true });
  }
  return profilesDir;
};

// List available profiles
router.get('/list', Auth.superAdmin(), async (req: Request, res: Response) => {
  try {
    const profilesDir = await ensureProfilesDir();
    const files = await fs.readdir(profilesDir);

    // Get file stats for each profile
    const profileStats = await Promise.all(
      files.map(async (filename) => {
        const stats = await fs.stat(path.join(profilesDir, filename));
        const type = filename.endsWith('.cpuprofile') 
          ? 'cpu' 
          : filename.endsWith('.heapsnapshot') 
            ? 'heap' 
            : 'unknown';
        
        return {
          filename,
          type,
          size: stats.size,
          created: stats.mtime,
        };
      })
    );

    // Group by type
    const groupedProfiles = {
      cpu: profileStats.filter(p => p.type === 'cpu'),
      heap: profileStats.filter(p => p.type === 'heap'),
    };

    res.json(groupedProfiles);
  } catch (error) {
    logger.error('Failed to list profiles:', error);
    res.status(500).json({ error: 'Failed to list profiles' });
  }
});

// Download profile
router.get(
  '/download/:filename',
  Auth.superAdminPassword(),
  async (req: Request, res: Response) => {
    try {
      const { filename } = req.params;
      const profilesDir = await ensureProfilesDir();
      const filePath = path.join(profilesDir, filename);

      // Check if file exists
      try {
        await fs.access(filePath);
      } catch {
        return res.status(404).json({ error: 'Profile file not found' });
      }

      // Set appropriate headers
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      
      // Set content type based on file extension
      if (filename.endsWith('.cpuprofile')) {
        res.setHeader('Content-Type', 'application/json');
      } else if (filename.endsWith('.heapsnapshot')) {
        res.setHeader('Content-Type', 'application/json');
      }
      
      // Stream the file directly
      const fileStream = createReadStream(filePath);
      fileStream.pipe(res);
      return;
    } catch (error) {
      logger.error('Failed to download profile:', error);
      return res.status(500).json({ error: 'Failed to download profile' });
    }
  }
);

// Delete profile
router.delete(
  '/delete/:filename',
  Auth.superAdminPassword(),
  async (req: Request, res: Response) => {
    try {
      const { filename } = req.params;
      const profilesDir = await ensureProfilesDir();
      const filePath = path.join(profilesDir, filename);

      // Check if file exists
      try {
        await fs.access(filePath);
      } catch {
        return res.status(404).json({ error: 'Profile file not found' });
      }

      await fs.unlink(filePath);
      return res.json({ success: true, message: 'Profile deleted successfully' });
    } catch (error) {
      logger.error('Failed to delete profile:', error);
      return res.status(500).json({ error: 'Failed to delete profile' });
    }
  }
);

// Rename profile
router.post(
  '/rename/:filename',
  Auth.superAdminPassword(),
  async (req: Request, res: Response) => {
    try {
      const { filename } = req.params;
      const { newName } = req.body;

      if (!newName) {
        return res.status(400).json({ error: 'New name is required' });
      }

      const profilesDir = await ensureProfilesDir();
      const oldPath = path.join(profilesDir, filename);
      const newPath = path.join(profilesDir, newName);

      // Check if file exists
      try {
        await fs.access(oldPath);
      } catch {
        return res.status(404).json({ error: 'Profile file not found' });
      }

      // Check if new name already exists
      try {
        await fs.access(newPath);
        return res.status(400).json({ error: 'A profile with this name already exists' });
      } catch {
        // This is good - the file doesn't exist
      }

      await fs.rename(oldPath, newPath);
      return res.json({
        success: true,
        message: 'Profile renamed successfully',
        newName,
      });
    } catch (error) {
      logger.error('Failed to rename profile:', error);
      return res.status(500).json({ error: 'Failed to rename profile' });
    }
  }
);

// Trigger CPU profiling
router.post(
  '/trigger/cpu',
  Auth.superAdminPassword(),
  async (req: Request, res: Response) => {
    try {
      const { duration = 60 } = req.body; // Duration in seconds, default 60
      
      // Start CPU profiling in a separate process
      const { spawn } = await import('child_process');
      const profilesDir = await ensureProfilesDir();
      
      // Generate a timestamp for the profile filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const profilePath = path.join(profilesDir, `cpu-profile-${timestamp}.cpuprofile`);
      
      // Run the profiling script with proper flags
      const child = spawn('node', [
        '--inspect',  // Changed from --prof to --inspect for proper inspector connection
        '--max-old-space-size=8192',
        '--expose-gc',
        'dist/profiling/profileCPU.js'
      ], {
        detached: true,
        stdio: 'ignore'
      });
      
      // Store the PID for later use
      const pid = child.pid;
      logger.info(`Started CPU profiling process with PID: ${pid}`);
      
      // Detach the child process
      child.unref();
      
      // Set a timeout to kill the process after the specified duration
      setTimeout(() => {
        try {
          if (pid) {
            // On Windows, we need to use taskkill to kill the process tree
            if (process.platform === 'win32') {
              exec(`taskkill /pid ${pid} /T /F`, (error: any) => {
                if (error) {
                  logger.error('Error killing profiling process with taskkill:', error);
                } else {
                  logger.info(`Successfully killed profiling process with PID: ${pid}`);
                }
              });
            } else {
              // On Unix-like systems, we can use process.kill with a negative PID
              process.kill(-pid);
              logger.info(`Successfully killed profiling process with PID: ${pid}`);
            }
          }
        } catch (error) {
          logger.error('Error killing profiling process:', error);
        }
      }, duration * 1000);
      
      return res.json({
        success: true,
        message: `CPU profiling started for ${duration} seconds`,
        profilePath,
        pid
      });
    } catch (error) {
      logger.error('Failed to trigger CPU profiling:', error);
      return res.status(500).json({ error: 'Failed to trigger CPU profiling' });
    }
  }
);

// Trigger heap snapshot
router.post(
  '/trigger/heap',
  Auth.superAdminPassword(),
  async (req: Request, res: Response) => {
    try {
      // Start heap snapshot in a separate process
      const { spawn } = await import('child_process');
      const profilesDir = await ensureProfilesDir();
      
      // Generate a timestamp for the snapshot filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const snapshotPath = path.join(profilesDir, `heap-snapshot-${timestamp}.heapsnapshot`);
      
      // Run the profiling script
      const child = spawn('node', [
        '--inspect',
        '--max-old-space-size=8192',
        '--expose-gc',
        'dist/profiling/profileHeap.js'
      ], {
        detached: true,
        stdio: 'ignore'
      });
      
      // Store the PID for later use
      const pid = child.pid;
      logger.info(`Started heap snapshot process with PID: ${pid}`);
      
      // Detach the child process
      child.unref();
      
      // Set a timeout to kill the process after 30 seconds (should be enough time to take a snapshot)
      setTimeout(() => {
        try {
          if (pid) {
            // On Windows, we need to use taskkill to kill the process tree
            if (process.platform === 'win32') {
              exec(`taskkill /pid ${pid} /T /F`, (error: any) => {
                if (error) {
                  logger.error('Error killing profiling process with taskkill:', error);
                } else {
                  logger.info(`Successfully killed profiling process with PID: ${pid}`);
                }
              });
            } else {
              // On Unix-like systems, we can use process.kill with a negative PID
              process.kill(-pid);
              logger.info(`Successfully killed profiling process with PID: ${pid}`);
            }
          }
        } catch (error) {
          logger.error('Error killing profiling process:', error);
        }
      }, 30000);
      
      return res.json({
        success: true,
        message: 'Heap snapshot started',
        snapshotPath,
        pid
      });
    } catch (error) {
      logger.error('Failed to trigger heap snapshot:', error);
      return res.status(500).json({ error: 'Failed to trigger heap snapshot' });
    }
  }
);

// Trigger combined profiling (CPU + heap)
router.post(
  '/trigger/combined',
  Auth.superAdminPassword(),
  async (req: Request, res: Response) => {
    try {
      const { duration = 10 } = req.body; // Duration in seconds, default 60
      
      // Start combined profiling in a separate process
      const { spawn } = await import('child_process');
      const profilesDir = await ensureProfilesDir();
      
      // Generate a timestamp for the profile filenames
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const cpuProfilePath = path.join(profilesDir, `cpu-profile-${timestamp}.cpuprofile`);
      const heapSnapshotPath = path.join(profilesDir, `heap-snapshot-${timestamp}.heapsnapshot`);
      
      // Run the profiling script
      const child = spawn('node', [
        '--inspect',
        '--max-old-space-size=8192',
        '--expose-gc',
        'dist/profiling/profile.js'
      ], {
        detached: true,
        stdio: 'ignore'
      });
      
      // Store the PID for later use
      const pid = child.pid;
      logger.info(`Started combined profiling process with PID: ${pid}`);
      
      // Detach the child process
      child.unref();
      
      // Set a timeout to kill the process after the specified duration
      setTimeout(() => {
        try {
          if (pid) {
            // On Windows, we need to use taskkill to kill the process tree
            if (process.platform === 'win32') {
              exec(`taskkill /pid ${pid} /T /F`, (error: any) => {
                if (error) {
                  logger.error('Error killing profiling process with taskkill:', error);
                } else {
                  logger.info(`Successfully killed profiling process with PID: ${pid}`);
                }
              });
            } else {
              // On Unix-like systems, we can use process.kill with a negative PID
              process.kill(-pid);
              logger.info(`Successfully killed profiling process with PID: ${pid}`);
            }
          }
        } catch (error) {
          logger.error('Error killing profiling process:', error);
        }
      }, duration * 1000);
      
      return res.json({
        success: true,
        message: `Combined profiling started for ${duration} seconds`,
        cpuProfilePath,
        heapSnapshotPath,
        pid
      });
    } catch (error) {
      logger.error('Failed to trigger combined profiling:', error);
      return res.status(500).json({ error: 'Failed to trigger combined profiling' });
    }
  }
);

// Enable/disable remote profiling
router.post(
  '/remote/toggle',
  Auth.superAdminPassword(),
  async (req: Request, res: Response) => {
    try {
      const { enable = false } = req.body;
      
      if (enable) {
        // Check if remote profiling is already running
        if (remoteProfilingProcess) {
          return res.status(400).json({ 
            error: 'Remote profiling is already enabled',
            pid: remoteProfilingProcess.pid
          });
        }
        
        
        // Run the remote profiler script
        remoteProfilingProcess = spawn('node', [
          '--max-old-space-size=8192',
          'dist/profiling/remoteProfiler.js'
        ], {
          detached: true,
          stdio: 'ignore'
        });
        
        // Store the PID for later use
        const pid = remoteProfilingProcess.pid;
        logger.info(`Started remote profiling process with PID: ${pid}`);
        
        // Detach the child process
        remoteProfilingProcess.unref();
        
        return res.json({
          success: true,
          message: 'Remote profiling enabled',
          pid
        });
      } else {
        // Check if remote profiling is running
        if (!remoteProfilingProcess) {
          return res.status(400).json({ 
            error: 'Remote profiling is not enabled'
          });
        }
        
        // Kill the remote profiling process
        const pid = remoteProfilingProcess.pid;
        
        try {
          if (pid) {
            // On Windows, we need to use taskkill to kill the process tree
            if (process.platform === 'win32') {
              exec(`taskkill /pid ${pid} /T /F`, (error: any) => {
                if (error) {
                  logger.error('Error killing remote profiling process with taskkill:', error);
                } else {
                  logger.info(`Successfully killed remote profiling process with PID: ${pid}`);
                }
              });
            } else {
              // On Unix-like systems, we can use process.kill with a negative PID
              process.kill(-pid);
              logger.info(`Successfully killed remote profiling process with PID: ${pid}`);
            }
          }
        } catch (error) {
          logger.error('Error killing remote profiling process:', error);
        }
        
        // Clear the reference
        remoteProfilingProcess = null;
        
        return res.json({
          success: true,
          message: 'Remote profiling disabled'
        });
      }
    } catch (error) {
      logger.error('Failed to toggle remote profiling:', error);
      return res.status(500).json({ error: 'Failed to toggle remote profiling' });
    }
  }
);

// Get remote profiling status
router.get(
  '/remote/status',
  Auth.superAdminPassword(),
  async (req: Request, res: Response) => {
    try {
      const isEnabled = !!remoteProfilingProcess;
      const pid = remoteProfilingProcess?.pid;
      
      return res.json({
        success: true,
        enabled: isEnabled,
        pid
      });
    } catch (error) {
      logger.error('Failed to get remote profiling status:', error);
      return res.status(500).json({ error: 'Failed to get remote profiling status' });
    }
  }
);

export default router;
