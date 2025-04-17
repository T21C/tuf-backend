import * as inspector from 'node:inspector';
import fs from 'node:fs';
import path from 'path';

// Configuration
const config = {
  duration: 60 * 1000, // 60 seconds
  maxProfiles: 5, // Keep only the 5 most recent profiles
};

// Create a directory for profiles if it doesn't exist
const profilesDir = path.join(process.cwd(), 'profiles');
if (!fs.existsSync(profilesDir)) {
  fs.mkdirSync(profilesDir);
}

// Generate a timestamp for the profile filename
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const profilePath = path.join(profilesDir, `cpu-profile-${timestamp}.cpuprofile`);

console.log(`Starting CPU profiling. Profile will be saved to: ${profilePath}`);

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
              fs.writeFileSync(profilePath, JSON.stringify(result.profile));
              console.log(`CPU profile saved to: ${profilePath}`);
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

// Function to clean up old CPU profiles
function cleanupOldProfiles() {
  try {
    const files = fs.readdirSync(profilesDir);
    const cpuProfiles = files.filter(file => file.endsWith('.cpuprofile'));
    
    // Sort by creation time (newest first)
    const sortByTime = (a: string, b: string) => {
      const statA = fs.statSync(path.join(profilesDir, a));
      const statB = fs.statSync(path.join(profilesDir, b));
      return statB.birthtimeMs - statA.birthtimeMs;
    };
    
    cpuProfiles.sort(sortByTime);
    
    // Remove excess profiles
    if (cpuProfiles.length > config.maxProfiles) {
      for (let i = config.maxProfiles; i < cpuProfiles.length; i++) {
        fs.unlinkSync(path.join(profilesDir, cpuProfiles[i]));
        console.log(`Removed old CPU profile: ${cpuProfiles[i]}`);
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
    
    // Clean up old profiles
    cleanupOldProfiles();
    
    // Set up a signal handler to stop profiling on SIGINT (Ctrl+C)
    process.on('SIGINT', () => {
      console.log('Stopping profiling...');
      session.disconnect();
      process.exit(0);
    });
    
    console.log('CPU profiling completed. Press Ctrl+C to exit.');
  } catch (error) {
    console.error('Error during profiling:', error);
    session.disconnect();
    process.exit(1);
  }
}

// Start profiling
profile(); 