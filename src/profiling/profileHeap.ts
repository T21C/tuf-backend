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

// Connect to the inspector
session.connect();

// Open a file to write the heap snapshot
const fd = fs.openSync(snapshotPath, 'w');

// Listen for heap snapshot chunks
session.on('HeapProfiler.addHeapSnapshotChunk', (m) => {
  fs.writeSync(fd, m.params.chunk);
});

// Take a heap snapshot
session.post('HeapProfiler.takeHeapSnapshot', (err: any, r: any) => {
  if (err) {
    console.error('Error taking heap snapshot:', err);
    fs.closeSync(fd);
    process.exit(1);
  }
  
  console.log('Heap snapshot completed');
  session.disconnect();
  fs.closeSync(fd);
  console.log(`Heap snapshot saved to: ${snapshotPath}`);
  process.exit(0);
}); 