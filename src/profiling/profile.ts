import * as inspector from 'node:inspector';
import fs from 'node:fs';
import path from 'path';

// Configuration
const config = {
  duration: 60 * 1000, // 60 seconds
  maxProfiles: 5, // Keep only the 5 most recent profiles
  interval: 20 * 1000, // Take a heap snapshot every 10 seconds
};

// Create a directory for profiles if it doesn't exist
const profilesDir = path.join(process.cwd(), 'profiles');
if (!fs.existsSync(profilesDir)) {
  fs.mkdirSync(profilesDir);
}

// Generate a timestamp for the profile filename
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const cpuProfilePath = path.join(profilesDir, `cpu-profile-${timestamp}.cpuprofile`);
const heapSnapshotPath = path.join(profilesDir, `heap-snapshot-${timestamp}.heapsnapshot`);

console.log(`Starting profiling. CPU profile will be saved to: ${cpuProfilePath}`);
console.log(`Heap snapshot will be saved to: ${heapSnapshotPath}`);

// Create a new inspector session
const session = new inspector.Session();

// Add error handling for the session
session.on('inspectorNotification', (message) => {
  console.log('Inspector notification:', message);
});

// Connect to the inspector with error handling
try {
  console.log('Attempting to connect to Node.js inspector...');
  session.connect();
  console.log('Successfully connected to Node.js inspector');
} catch (error) {
  console.error('Failed to connect to Node.js inspector:', error);
  console.error('Make sure your Node.js application is running with the --inspect flag');
  console.error('Example: node --inspect --max-old-space-size=8192 --expose-gc dist/app.js');
  process.exit(1);
}

// Function to take a CPU profile
function takeCPUProfile() {
  return new Promise<void>((resolve, reject) => {
    console.log('Starting CPU profiling...');
    
    // Enable the profiler
    session.post('Profiler.enable', (err) => {
      if (err) {
        console.error('Error enabling profiler:', err);
        reject(err);
        return;
      }
      
      // Start profiling
      session.post('Profiler.start', (err) => {
        if (err) {
          console.error('Error starting profiler:', err);
          reject(err);
          return;
        }
        
        console.log('CPU profiling started');
        
        // Stop profiling after the configured duration
        setTimeout(() => {
          session.post('Profiler.stop', (err, result) => {
            if (err) {
              console.error('Error stopping profiler:', err);
              reject(err);
              return;
            }
            
            // Write the profile to a file
            try {
              fs.writeFileSync(cpuProfilePath, JSON.stringify(result.profile));
              console.log(`CPU profile saved to: ${cpuProfilePath}`);
              resolve();
            } catch (writeError) {
              console.error('Error writing CPU profile:', writeError);
              reject(writeError);
            }
          });
        }, config.duration);
      });
    });
  });
}

// Function to take a heap snapshot
function takeHeapSnapshot() {
  return new Promise<void>((resolve, reject) => {
    console.log('Taking heap snapshot...');
    
    // Open a file to write the heap snapshot
    let fd: number;
    try {
      fd = fs.openSync(heapSnapshotPath, 'w');
      console.log('Opened file for heap snapshot');
    } catch (error) {
      console.error('Failed to open file for heap snapshot:', error);
      reject(error);
      return;
    }
    
    // Listen for heap snapshot chunks
    const chunkListener = (m: any) => {
      try {
        fs.writeSync(fd, m.params.chunk);
      } catch (error) {
        console.error('Error writing heap snapshot chunk:', error);
      }
    };
    
    session.on('HeapProfiler.addHeapSnapshotChunk', chunkListener);
    
    // Take a heap snapshot
    session.post('HeapProfiler.takeHeapSnapshot', (err) => {
      // Remove the listener to avoid memory leaks
      session.removeListener('HeapProfiler.addHeapSnapshotChunk', chunkListener);
      
      if (err) {
        console.error('Error taking heap snapshot:', err);
        try {
          fs.closeSync(fd);
        } catch (closeError) {
          console.error('Error closing file after error:', closeError);
        }
        reject(err);
        return;
      }
      
      console.log('Heap snapshot completed');
      try {
        fs.closeSync(fd);
        console.log(`Heap snapshot saved to: ${heapSnapshotPath}`);
        resolve();
      } catch (closeError) {
        console.error('Error closing file:', closeError);
        reject(closeError);
      }
    });
  });
}

// Function to clean up old profiles
function cleanupOldProfiles() {
  try {
    const files = fs.readdirSync(profilesDir);
    const cpuProfiles = files.filter(file => file.endsWith('.cpuprofile'));
    const heapSnapshots = files.filter(file => file.endsWith('.heapsnapshot'));
    
    // Sort by creation time (newest first)
    const sortByTime = (a: string, b: string) => {
      const statA = fs.statSync(path.join(profilesDir, a));
      const statB = fs.statSync(path.join(profilesDir, b));
      return statB.birthtimeMs - statA.birthtimeMs;
    };
    
    cpuProfiles.sort(sortByTime);
    heapSnapshots.sort(sortByTime);
    
    // Remove excess profiles
    if (cpuProfiles.length > config.maxProfiles) {
      for (let i = config.maxProfiles; i < cpuProfiles.length; i++) {
        fs.unlinkSync(path.join(profilesDir, cpuProfiles[i]));
        console.log(`Removed old CPU profile: ${cpuProfiles[i]}`);
      }
    }
    
    if (heapSnapshots.length > config.maxProfiles) {
      for (let i = config.maxProfiles; i < heapSnapshots.length; i++) {
        fs.unlinkSync(path.join(profilesDir, heapSnapshots[i]));
        console.log(`Removed old heap snapshot: ${heapSnapshots[i]}`);
      }
    }
  } catch (error) {
    console.error('Error cleaning up old profiles:', error);
  }
}

// Main profiling function
async function profile() {
  try {
    // Take a CPU profile
    await takeCPUProfile();
    
    // Take heap snapshots at intervals
    const intervalId = setInterval(async () => {
      try {
        await takeHeapSnapshot();
      } catch (error) {
        console.error('Error taking heap snapshot:', error);
      }
    }, config.interval);
    
    // Clean up old profiles
    cleanupOldProfiles();
    
    // Set up a signal handler to stop profiling on SIGINT (Ctrl+C)
    process.on('SIGINT', () => {
      console.log('Stopping profiling...');
      clearInterval(intervalId);
      session.disconnect();
      process.exit(0);
    });
    
    console.log('Profiling in progress. Press Ctrl+C to stop.');
  } catch (error) {
    console.error('Error during profiling:', error);
    session.disconnect();
    process.exit(1);
  }
}

// Start profiling
profile(); 