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
const profilePath = path.join(profilesDir, `cpu-profile-${timestamp}.cpuprofile`);

console.log(`Starting CPU profiling. Profile will be saved to: ${profilePath}`);

// Create a new inspector session
const session = new inspector.Session();

// Connect to the inspector
session.connect();

// Enable the profiler
session.post('Profiler.enable', () => {
  console.log('Profiler enabled');
  
  // Start profiling
  session.post('Profiler.start', () => {
    console.log('CPU profiling started');
    
    // Set up a signal handler to stop profiling on SIGINT (Ctrl+C)
    process.on('SIGINT', () => {
      console.log('Stopping CPU profiling...');
      
      // Stop profiling and save the profile
      session.post('Profiler.stop', (err, { profile }) => {
        if (err) {
          console.error('Error stopping profiler:', err);
          process.exit(1);
        }
        
        // Write the profile to a file
        fs.writeFileSync(profilePath, JSON.stringify(profile));
        console.log(`CPU profile saved to: ${profilePath}`);
        
        // Disconnect the session
        session.disconnect();
        process.exit(0);
      });
    });
    
    console.log('Press Ctrl+C to stop profiling and save the profile');
  });
}); 