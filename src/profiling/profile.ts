import * as inspector from 'node:inspector';
import fs from 'node:fs';
import path from 'path';

// Create a directory for profiles if it doesn't exist
const profilesDir = path.join(process.cwd(), 'profiles');
if (!fs.existsSync(profilesDir)) {
  fs.mkdirSync(profilesDir);
}

// Generate a timestamp for the profile filename
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

// Configuration
const config = {
  cpuProfileDuration: 30000, // 30 seconds
  heapSnapshotInterval: 60000, // 1 minute
  maxProfiles: 5, // Maximum number of profiles to keep
};

console.log('Starting profiling with the following configuration:');
console.log(`- CPU profiles: ${config.cpuProfileDuration / 1000} seconds each`);
console.log(`- Heap snapshots: every ${config.heapSnapshotInterval / 1000} seconds`);
console.log(`- Maximum profiles to keep: ${config.maxProfiles}`);

// Create a new inspector session
const session = new inspector.Session();

// Connect to the inspector
session.connect();

// Function to take a CPU profile
function takeCPUProfile() {
  const profilePath = path.join(profilesDir, `cpu-profile-${timestamp}-${Date.now()}.cpuprofile`);
  console.log(`Taking CPU profile: ${profilePath}`);
  
  // Enable the profiler
  session.post('Profiler.enable', () => {
    // Start profiling
    session.post('Profiler.start', () => {
      console.log('CPU profiling started');
      
      // Stop profiling after the specified duration
      setTimeout(() => {
        session.post('Profiler.stop', (err, { profile }) => {
          if (err) {
            console.error('Error stopping profiler:', err);
            return;
          }
          
          // Write the profile to a file
          fs.writeFileSync(profilePath, JSON.stringify(profile));
          console.log(`CPU profile saved to: ${profilePath}`);
          
          // Clean up old profiles
          cleanupOldProfiles('cpu-profile');
        });
      }, config.cpuProfileDuration);
    });
  });
}

// Function to take a heap snapshot
function takeHeapSnapshot() {
  const snapshotPath = path.join(profilesDir, `heap-snapshot-${timestamp}-${Date.now()}.heapsnapshot`);
  console.log(`Taking heap snapshot: ${snapshotPath}`);
  
  // Open a file to write the heap snapshot
  const fd = fs.openSync(snapshotPath, 'w');
  
  // Listen for heap snapshot chunks
  const chunkListener = (m: any) => {
    fs.writeSync(fd, m.params.chunk);
  };
  
  session.on('HeapProfiler.addHeapSnapshotChunk', chunkListener);
  
  // Take a heap snapshot
  session.post('HeapProfiler.takeHeapSnapshot', (err: any, r: any) => {
    // Remove the listener
    session.removeListener('HeapProfiler.addHeapSnapshotChunk', chunkListener);
    
    if (err) {
      console.error('Error taking heap snapshot:', err);
      fs.closeSync(fd);
      return;
    }
    
    fs.closeSync(fd);
    console.log(`Heap snapshot saved to: ${snapshotPath}`);
    
    // Clean up old profiles
    cleanupOldProfiles('heap-snapshot');
  });
}

// Function to clean up old profiles
function cleanupOldProfiles(prefix: string) {
  const files = fs.readdirSync(profilesDir)
    .filter(file => file.startsWith(prefix))
    .map(file => ({
      name: file,
      path: path.join(profilesDir, file),
      time: fs.statSync(path.join(profilesDir, file)).mtime.getTime()
    }))
    .sort((a, b) => b.time - a.time);
  
  // Remove old files if we have more than the maximum
  if (files.length > config.maxProfiles) {
    for (let i = config.maxProfiles; i < files.length; i++) {
      fs.unlinkSync(files[i].path);
      console.log(`Removed old profile: ${files[i].name}`);
    }
  }
}

// Set up signal handlers
process.on('SIGINT', () => {
  console.log('Stopping profiling...');
  session.disconnect();
  process.exit(0);
});

// Start profiling
console.log('Starting profiling. Press Ctrl+C to stop.');

// Take initial CPU profile
takeCPUProfile();

// Take CPU profiles at intervals
setInterval(takeCPUProfile, config.cpuProfileDuration * 2);

// Take heap snapshots at intervals
setInterval(takeHeapSnapshot, config.heapSnapshotInterval); 