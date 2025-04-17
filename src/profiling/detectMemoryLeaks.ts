import * as inspector from 'node:inspector';
import fs from 'node:fs';
import path from 'path';

// Create a directory for profiles if it doesn't exist
const profilesDir = path.join(process.cwd(), 'profiles');
if (!fs.existsSync(profilesDir)) {
  fs.mkdirSync(profilesDir);
}

// Configuration
const config = {
  snapshotInterval: 30000, // 30 seconds
  maxSnapshots: 3, // Number of snapshots to compare
  maxRetentionBytes: 1024 * 1024 * 10, // 10MB threshold for potential leaks
};

console.log('Starting memory leak detection with the following configuration:');
console.log(`- Snapshot interval: ${config.snapshotInterval / 1000} seconds`);
console.log(`- Number of snapshots to compare: ${config.maxSnapshots}`);
console.log(`- Memory retention threshold: ${config.maxRetentionBytes / (1024 * 1024)} MB`);

// Create a new inspector session
const session = new inspector.Session();

// Connect to the inspector
session.connect();

// Store snapshots for comparison
const snapshots: any[] = [];

// Function to take a heap snapshot
function takeHeapSnapshot() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(profilesDir, `leak-detection-${timestamp}-${Date.now()}.heapsnapshot`);
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
    
    // Add the snapshot to our collection
    snapshots.push({
      path: snapshotPath,
      time: Date.now()
    });
    
    // Keep only the most recent snapshots
    if (snapshots.length > config.maxSnapshots) {
      const oldestSnapshot = snapshots.shift();
      fs.unlinkSync(oldestSnapshot.path);
      console.log(`Removed old snapshot: ${oldestSnapshot.path}`);
    }
    
    // If we have enough snapshots, compare them
    if (snapshots.length >= 2) {
      compareSnapshots(snapshots[snapshots.length - 2], snapshots[snapshots.length - 1]);
    }
  });
}

// Function to compare two heap snapshots
function compareSnapshots(snapshot1: any, snapshot2: any) {
  console.log(`Comparing snapshots taken ${(snapshot2.time - snapshot1.time) / 1000} seconds apart`);
  
  // Read the snapshots
  const snapshot1Data = JSON.parse(fs.readFileSync(snapshot1.path, 'utf8'));
  const snapshot2Data = JSON.parse(fs.readFileSync(snapshot2.path, 'utf8'));
  
  // Create maps of nodes by ID for easier comparison
  const nodes1 = new Map();
  const nodes2 = new Map();
  
  snapshot1Data.nodes.forEach((node: any, index: number) => {
    const nodeId = snapshot1Data.nodes[index];
    nodes1.set(nodeId, {
      type: snapshot1Data.nodes[index + 1],
      name: snapshot1Data.nodes[index + 2],
      size: snapshot1Data.nodes[index + 3],
      edgeCount: snapshot1Data.nodes[index + 4],
      index: index
    });
  });
  
  snapshot2Data.nodes.forEach((node: any, index: number) => {
    const nodeId = snapshot2Data.nodes[index];
    nodes2.set(nodeId, {
      type: snapshot2Data.nodes[index + 1],
      name: snapshot2Data.nodes[index + 2],
      size: snapshot2Data.nodes[index + 3],
      edgeCount: snapshot2Data.nodes[index + 4],
      index: index
    });
  });
  
  // Find nodes that have grown significantly
  const potentialLeaks = [];
  
  for (const [nodeId, node2] of nodes2.entries()) {
    const node1 = nodes1.get(nodeId);
    
    if (node1) {
      const sizeDiff = node2.size - node1.size;
      
      if (sizeDiff > config.maxRetentionBytes) {
        potentialLeaks.push({
          id: nodeId,
          type: node2.type,
          name: node2.name,
          sizeDiff: sizeDiff,
          sizeDiffMB: sizeDiff / (1024 * 1024)
        });
      }
    }
  }
  
  // Sort by size difference (largest first)
  potentialLeaks.sort((a, b) => b.sizeDiff - a.sizeDiff);
  
  // Report potential leaks
  if (potentialLeaks.length > 0) {
    console.log(`Found ${potentialLeaks.length} potential memory leaks:`);
    
    potentialLeaks.forEach((leak, index) => {
      console.log(`${index + 1}. ${leak.type} "${leak.name}" grew by ${leak.sizeDiffMB.toFixed(2)} MB`);
    });
    
    // Write detailed report to file
    const reportPath = path.join(profilesDir, `leak-report-${Date.now()}.txt`);
    const report = potentialLeaks.map((leak, index) => 
      `${index + 1}. ${leak.type} "${leak.name}" grew by ${leak.sizeDiffMB.toFixed(2)} MB`
    ).join('\n');
    
    fs.writeFileSync(reportPath, report);
    console.log(`Detailed report saved to: ${reportPath}`);
  } else {
    console.log('No significant memory leaks detected');
  }
}

// Set up signal handlers
process.on('SIGINT', () => {
  console.log('Stopping memory leak detection...');
  session.disconnect();
  process.exit(0);
});

// Start taking snapshots
console.log('Starting memory leak detection. Press Ctrl+C to stop.');

// Take initial snapshot
takeHeapSnapshot();

// Take snapshots at intervals
setInterval(takeHeapSnapshot, config.snapshotInterval); 