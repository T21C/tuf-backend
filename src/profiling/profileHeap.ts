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
const snapshotPath = path.join(profilesDir, `heap-snapshot-${timestamp}.heapsnapshot`);

console.log(`Starting heap snapshot. Snapshot will be saved to: ${snapshotPath}`);

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

// Open a file to write the heap snapshot
let fd: number;
try {
  fd = fs.openSync(snapshotPath, 'w');
  console.log('Opened file for heap snapshot');
} catch (error) {
  console.error('Failed to open file for heap snapshot:', error);
  session.disconnect();
  process.exit(1);
}

// Listen for heap snapshot chunks
session.on('HeapProfiler.addHeapSnapshotChunk', (m) => {
  try {
    fs.writeSync(fd, m.params.chunk);
  } catch (error) {
    console.error('Error writing heap snapshot chunk:', error);
  }
});

// Take a heap snapshot with error handling
console.log('Requesting heap snapshot...');
session.post('HeapProfiler.takeHeapSnapshot', (err: any, r: any) => {
  if (err) {
    console.error('Error taking heap snapshot:', err);
    try {
      fs.closeSync(fd);
    } catch (closeError) {
      console.error('Error closing file after error:', closeError);
    }
    session.disconnect();
    process.exit(1);
  }
  
  console.log('Heap snapshot completed');
  try {
    fs.closeSync(fd);
    console.log(`Heap snapshot saved to: ${snapshotPath}`);
  } catch (closeError) {
    console.error('Error closing file:', closeError);
  }
  
  session.disconnect();
  process.exit(0);
}); 