import * as inspector from 'node:inspector';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'path';
import { createServer } from 'node:net';
import os from 'os';

// Configuration
const config = {
  host: '0.0.0.0', // Listen on all network interfaces
  port: 9229, // Default Node.js inspector port
  ssl: false, // Set to true if you want to use SSL
  sslKey: '', // Path to SSL key file
  sslCert: '', // Path to SSL certificate file
  maxConnections: 5, // Maximum number of concurrent connections
  timeout: 3600000, // 1 hour timeout
  duration: 60000, // Default profiling duration in milliseconds
};

// Create a directory for profiles if it doesn't exist
const profilesDir = path.join(process.cwd(), 'profiles');
if (!fs.existsSync(profilesDir)) {
  fs.mkdirSync(profilesDir);
}

// Generate a timestamp for the profile filename
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const profilePath = path.join(profilesDir, `remote-cpu-profile-${timestamp}.cpuprofile`);

console.log(`Starting remote CPU profiling server on ${config.host}:${config.port}`);
console.log(`Profiles will be saved to: ${profilePath}`);

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
function takeCPUProfile(duration = config.duration) {
  return new Promise<void>((resolve, reject) => {
    console.log(`Starting CPU profiling for ${duration / 1000} seconds...`);
    
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
        }, duration);
      });
    });
  });
}

// Create a TCP server to handle WebSocket connections
const server = createServer((socket) => {
  console.log('New connection from:', socket.remoteAddress);
  
  // Set a timeout for the connection
  socket.setTimeout(config.timeout);
  
  // Handle socket events
  socket.on('timeout', () => {
    console.log('Connection timed out');
    socket.end();
  });
  
  socket.on('error', (err) => {
    console.error('Socket error:', err);
  });
  
  socket.on('close', () => {
    console.log('Connection closed');
  });
});

// Start the server
server.listen(config.port, config.host, () => {
  console.log(`Remote profiling server listening on ${config.host}:${config.port}`);
  console.log('To connect from Chrome DevTools, open:');
  console.log(`chrome://inspect/#devices`);
  console.log('Then click on "Configure..." and add:');
  console.log(`${config.host}:${config.port}`);
  console.log('Finally, click on "Open dedicated DevTools for Node"');
  
  // Log the server's IP address for easier connection
  const networkInterfaces = os.networkInterfaces();
  console.log('Available network interfaces:');
  Object.keys(networkInterfaces).forEach((interfaceName) => {
    networkInterfaces[interfaceName]?.forEach((iface) => {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(`  ${interfaceName}: ${iface.address}:${config.port}`);
      }
    });
  });
});

// Set up a signal handler to stop profiling on SIGINT (Ctrl+C)
process.on('SIGINT', () => {
  console.log('Stopping profiling server...');
  session.disconnect();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Export the server for use in other modules
export { server, takeCPUProfile }; 