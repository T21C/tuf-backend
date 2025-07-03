#!/usr/bin/env tsx

import { Sequelize } from 'sequelize';
import { performance } from 'perf_hooks';
import dotenv from 'dotenv';

dotenv.config();

// Create a direct connection for monitoring
const monitorSequelize = new Sequelize({
  dialect: 'mysql',
  host: process.env.DB_HOST,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.NODE_ENV === 'staging' 
    ? process.env.DB_STAGING_DATABASE 
    : process.env.DB_DATABASE,
  logging: false,
});

// Simulate your app's database configuration
const createAppConnection = (connectionId: number) => {
  return new Sequelize({
    dialect: 'mysql',
    host: process.env.DB_HOST,
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.NODE_ENV === 'staging' 
      ? process.env.DB_STAGING_DATABASE 
      : process.env.DB_DATABASE,
    logging: false,
    pool: {
      max: 20,
      min: 2,
      acquire: 60000,
      idle: 10000,
      evict: 30000,
    },
    dialectOptions: {
      connectTimeout: 60000,
      acquireTimeout: 60000,
      timeout: 60000,
    },
    retry: {
      max: 3,
      backoffBase: 1000,
      backoffExponent: 1.5,
    },
  });
};

interface ConnectionStats {
  total_connections: number;
  idle_connections: number;
  active_connections: number;
}

interface TestResults {
  successful: number;
  failed: number;
  timeouts: number;
  totalTime: number;
  avgResponseTime: number;
  maxResponseTime: number;
  minResponseTime: number;
}

async function getConnectionStats(): Promise<ConnectionStats | null> {
  try {
    const database = process.env.NODE_ENV === 'staging' 
      ? process.env.DB_STAGING_DATABASE 
      : process.env.DB_DATABASE;
    
    const [results] = await monitorSequelize.query(`
      SELECT 
        COUNT(*) as total_connections,
        COUNT(CASE WHEN Command = 'Sleep' THEN 1 END) as idle_connections,
        COUNT(CASE WHEN Command != 'Sleep' THEN 1 END) as active_connections
      FROM information_schema.processlist 
      WHERE db = ?
    `, {
      replacements: [database]
    });
    
    return results[0] as ConnectionStats;
  } catch (error) {
    console.error('Error getting connection stats:', error);
    return null;
  }
}

async function simulateConcurrentRequests(
  numConnections: number, 
  duration: number, 
  requestInterval: number
): Promise<TestResults> {
  console.log(`\n🚀 Starting load test:`);
  console.log(`   Connections: ${numConnections}`);
  console.log(`   Duration: ${duration}ms`);
  console.log(`   Request interval: ${requestInterval}ms`);
  
  const connections: Sequelize[] = [];
  const results: TestResults = {
    successful: 0,
    failed: 0,
    timeouts: 0,
    totalTime: 0,
    avgResponseTime: 0,
    maxResponseTime: 0,
    minResponseTime: Infinity,
  };

  const startTime = performance.now();
  const endTime = startTime + duration;

  // Create connection pool
  console.log('\n📦 Creating connection pool...');
  for (let i = 0; i < numConnections; i++) {
    try {
      const sequelize = createAppConnection(i);
      await sequelize.authenticate();
      connections.push(sequelize);
    } catch (error) {
      console.error(`Failed to create connection ${i}:`, error);
    }
  }
  console.log(`✅ Created ${connections.length} connections`);

  // Simulate requests
  console.log('\n🔄 Simulating concurrent requests...');
  const requestPromises: Promise<void>[] = [];
  let requestId = 0;

  const makeRequest = async (connection: Sequelize, id: number) => {
    const requestStart = performance.now();
    try {
      // Simulate different types of database operations
      const operations = [
        () => connection.query('SELECT 1 as test'),
        () => connection.query('SELECT COUNT(*) as count FROM information_schema.tables'),
        () => connection.query('SHOW PROCESSLIST'),
        () => connection.query('SELECT VERSION() as version'),
      ];
      
      const randomOp = operations[Math.floor(Math.random() * operations.length)];
      await randomOp();
      
      const requestTime = performance.now() - requestStart;
      results.successful++;
      results.totalTime += requestTime;
      results.maxResponseTime = Math.max(results.maxResponseTime, requestTime);
      results.minResponseTime = Math.min(results.minResponseTime, requestTime);
      
    } catch (error: any) {
      const requestTime = performance.now() - requestStart;
      if (error.message.includes('timeout') || error.message.includes('acquire')) {
        results.timeouts++;
      } else {
        results.failed++;
      }
      console.error(`Request ${id} failed:`, error.message);
    }
  };

  // Start making requests
  while (performance.now() < endTime) {
    for (let i = 0; i < connections.length; i++) {
      if (performance.now() >= endTime) break;
      
      const promise = makeRequest(connections[i], requestId++);
      requestPromises.push(promise);
      
      // Add interval between requests
      if (requestInterval > 0) {
        await new Promise(resolve => setTimeout(resolve, requestInterval));
      }
    }
  }

  // Wait for all requests to complete
  await Promise.all(requestPromises);

  // Calculate averages
  if (results.successful > 0) {
    results.avgResponseTime = results.totalTime / results.successful;
  }

  // Cleanup connections
  console.log('\n🧹 Cleaning up connections...');
  for (const connection of connections) {
    try {
      await connection.close();
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  return results;
}

async function runLoadTest() {
  const args = process.argv.slice(2);
  const numConnections = parseInt(args[0]) || 10;
  const duration = parseInt(args[1]) || 30000; // 30 seconds
  const requestInterval = parseInt(args[2]) || 100; // 100ms between requests

  try {
    await monitorSequelize.authenticate();
    console.log('✅ Monitor connection established');

    // Get initial stats
    console.log('\n📊 Initial connection stats:');
    const initialStats = await getConnectionStats();
    console.log(JSON.stringify(initialStats, null, 2));

    // Run load test
    const testResults = await simulateConcurrentRequests(numConnections, duration, requestInterval);

    // Get final stats
    console.log('\n📊 Final connection stats:');
    const finalStats = await getConnectionStats();
    console.log(JSON.stringify(finalStats, null, 2));

    // Display results
    console.log('\n📈 Load Test Results:');
    console.log('='.repeat(50));
    console.log(`Total Requests: ${testResults.successful + testResults.failed + testResults.timeouts}`);
    console.log(`Successful: ${testResults.successful}`);
    console.log(`Failed: ${testResults.failed}`);
    console.log(`Timeouts: ${testResults.timeouts}`);
    console.log(`Success Rate: ${((testResults.successful / (testResults.successful + testResults.failed + testResults.timeouts)) * 100).toFixed(2)}%`);
    console.log(`Average Response Time: ${testResults.avgResponseTime.toFixed(2)}ms`);
    console.log(`Min Response Time: ${testResults.minResponseTime === Infinity ? 'N/A' : testResults.minResponseTime.toFixed(2)}ms`);
    console.log(`Max Response Time: ${testResults.maxResponseTime.toFixed(2)}ms`);
    console.log('='.repeat(50));

    // Performance analysis
    console.log('\n🔍 Performance Analysis:');
    if (testResults.timeouts > 0) {
      console.log('⚠️  Connection timeouts detected - consider increasing pool size or timeouts');
    }
    if (testResults.avgResponseTime > 1000) {
      console.log('⚠️  High average response time - consider optimizing queries or connection pool');
    }
    if (finalStats && finalStats.total_connections > 15) {
      console.log('⚠️  High connection count - consider reducing pool size or implementing connection cleanup');
    }
    if (testResults.successful > 0 && testResults.avgResponseTime < 100) {
      console.log('✅ Good performance - connection pool is working well');
    }

  } catch (error) {
    console.error('❌ Load test failed:', error);
  } finally {
    await monitorSequelize.close();
  }
}

// CLI usage
if (import.meta.url === new URL(import.meta.url).href) {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
Database Load Testing Tool

Usage: npm run load-test [connections] [duration_ms] [interval_ms]

Parameters:
  connections  - Number of concurrent connections (default: 10)
  duration_ms  - Test duration in milliseconds (default: 30000)
  interval_ms  - Interval between requests in milliseconds (default: 100)

Examples:
  npm run load-test                    # Default test (10 connections, 30s)
  npm run load-test 20                 # 20 connections, 30s
  npm run load-test 20 60000           # 20 connections, 60s
  npm run load-test 20 60000 50        # 20 connections, 60s, 50ms interval

This will simulate your application's database load and help identify:
- Connection pool performance
- Timeout issues
- Response time patterns
- Optimal pool configuration
    `);
  } else {
    runLoadTest();
  }
} 