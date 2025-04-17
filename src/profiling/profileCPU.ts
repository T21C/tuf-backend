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

// Enable the profiler with error handling
session.post('Profiler.enable', (err) => {
  if (err) {
    console.error('Failed to enable profiler:', err);
    session.disconnect();
    process.exit(1);
  }
  
  console.log('Profiler enabled');
  
  // Start profiling with error handling
  session.post('Profiler.start', (err) => {
    if (err) {
      console.error('Failed to start profiling:', err);
      session.disconnect();
      process.exit(1);
    }
    
    console.log('CPU profiling started');
    
    // Set up a signal handler to stop profiling on SIGINT (Ctrl+C)
    process.on('SIGINT', () => {
      console.log('Stopping CPU profiling...');
      
      // Stop profiling and save the profile
      session.post('Profiler.stop', (err, { profile }) => {
        if (err) {
          console.error('Error stopping profiler:', err);
          session.disconnect();
          process.exit(1);
        }
        
        try {
          // Write the profile to a file
          fs.writeFileSync(profilePath, JSON.stringify(profile));
          console.log(`CPU profile saved to: ${profilePath}`);
        } catch (writeError) {
          console.error('Error writing profile to file:', writeError);
        }
        
        // Disconnect the session
        session.disconnect();
        process.exit(0);
      });
    });
    
    console.log('Press Ctrl+C to stop profiling and save the profile');
  });
}); 