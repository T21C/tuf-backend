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
  operationStats: Record<string, { count: number; avgTime: number; totalTime: number }>;
}

// Realistic database operations that your app might perform
const realisticOperations = [
  {
    name: 'user_profile_lookup',
    query: 'SELECT id, username, email, created_at FROM users WHERE id = ? LIMIT 1',
    params: () => [Math.floor(Math.random() * 1000) + 1],
    weight: 30, // 30% of requests
  },
  {
    name: 'level_listing',
    query: 'SELECT id, title, creator_id, difficulty, created_at FROM levels WHERE status = ? ORDER BY created_at DESC LIMIT ?',
    params: () => ['published', Math.floor(Math.random() * 50) + 10],
    weight: 25, // 25% of requests
  },
  {
    name: 'score_lookup',
    query: 'SELECT player_id, level_id, score, accuracy, created_at FROM scores WHERE level_id = ? ORDER BY score DESC LIMIT ?',
    params: () => [Math.floor(Math.random() * 500) + 1, Math.floor(Math.random() * 20) + 5],
    weight: 20, // 20% of requests
  },
  {
    name: 'player_stats',
    query: 'SELECT COUNT(*) as total_scores, AVG(score) as avg_score, MAX(score) as best_score FROM scores WHERE player_id = ?',
    params: () => [Math.floor(Math.random() * 1000) + 1],
    weight: 15, // 15% of requests
  },
  {
    name: 'leaderboard',
    query: 'SELECT p.username, COUNT(s.id) as total_scores, AVG(s.score) as avg_score FROM players p LEFT JOIN scores s ON p.id = s.player_id GROUP BY p.id ORDER BY avg_score DESC LIMIT ?',
    params: () => [Math.floor(Math.random() * 50) + 10],
    weight: 10, // 10% of requests
  },
];

function selectRandomOperation() {
  const random = Math.random() * 100;
  let cumulativeWeight = 0;
  
  for (const operation of realisticOperations) {
    cumulativeWeight += operation.weight;
    if (random <= cumulativeWeight) {
      return operation;
    }
  }
  
  return realisticOperations[0]; // fallback
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

async function simulateRealisticRequests(
  numConnections: number, 
  duration: number, 
  requestInterval: number
): Promise<TestResults> {
  console.log(`\n🚀 Starting realistic load test:`);
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
    operationStats: {},
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

  // Simulate realistic requests
  console.log('\n🔄 Simulating realistic application requests...');
  const requestPromises: Promise<void>[] = [];
  let requestId = 0;

  const makeRequest = async (connection: Sequelize, id: number) => {
    const requestStart = performance.now();
    try {
      const operation = selectRandomOperation();
      const params = operation.params();
      
      await connection.query(operation.query, {
        replacements: params
      });
      
      const requestTime = performance.now() - requestStart;
      results.successful++;
      results.totalTime += requestTime;
      results.maxResponseTime = Math.max(results.maxResponseTime, requestTime);
      results.minResponseTime = Math.min(results.minResponseTime, requestTime);
      
      // Track operation-specific stats
      if (!results.operationStats[operation.name]) {
        results.operationStats[operation.name] = { count: 0, avgTime: 0, totalTime: 0 };
      }
      const stats = results.operationStats[operation.name];
      stats.count++;
      stats.totalTime += requestTime;
      stats.avgTime = stats.totalTime / stats.count;
      
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

async function runRealisticLoadTest() {
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
    const testResults = await simulateRealisticRequests(numConnections, duration, requestInterval);

    // Get final stats
    console.log('\n📊 Final connection stats:');
    const finalStats = await getConnectionStats();
    console.log(JSON.stringify(finalStats, null, 2));

    // Display results
    console.log('\n📈 Realistic Load Test Results:');
    console.log('='.repeat(60));
    console.log(`Total Requests: ${testResults.successful + testResults.failed + testResults.timeouts}`);
    console.log(`Successful: ${testResults.successful}`);
    console.log(`Failed: ${testResults.failed}`);
    console.log(`Timeouts: ${testResults.timeouts}`);
    console.log(`Success Rate: ${((testResults.successful / (testResults.successful + testResults.failed + testResults.timeouts)) * 100).toFixed(2)}%`);
    console.log(`Average Response Time: ${testResults.avgResponseTime.toFixed(2)}ms`);
    console.log(`Min Response Time: ${testResults.minResponseTime === Infinity ? 'N/A' : testResults.minResponseTime.toFixed(2)}ms`);
    console.log(`Max Response Time: ${testResults.maxResponseTime.toFixed(2)}ms`);
    console.log('='.repeat(60));

    // Operation-specific stats
    console.log('\n📊 Operation Performance:');
    console.log('-'.repeat(60));
    for (const [operationName, stats] of Object.entries(testResults.operationStats)) {
      console.log(`${operationName.padEnd(20)} | Count: ${stats.count.toString().padStart(4)} | Avg: ${stats.avgTime.toFixed(2)}ms`);
    }
    console.log('-'.repeat(60));

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

    // Identify slowest operations
    const slowestOperation = Object.entries(testResults.operationStats)
      .sort(([,a], [,b]) => b.avgTime - a.avgTime)[0];
    if (slowestOperation && slowestOperation[1].avgTime > 500) {
      console.log(`⚠️  Slow operation detected: ${slowestOperation[0]} (${slowestOperation[1].avgTime.toFixed(2)}ms avg)`);
    }

  } catch (error) {
    console.error('❌ Realistic load test failed:', error);
  } finally {
    await monitorSequelize.close();
  }
}

// CLI usage
if (import.meta.url === new URL(import.meta.url).href) {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
Realistic Database Load Testing Tool

Usage: npm run realistic-load-test [connections] [duration_ms] [interval_ms]

Parameters:
  connections  - Number of concurrent connections (default: 10)
  duration_ms  - Test duration in milliseconds (default: 30000)
  interval_ms  - Interval between requests in milliseconds (default: 100)

Examples:
  npm run realistic-load-test                    # Default test (10 connections, 30s)
  npm run realistic-load-test 20                 # 20 connections, 30s
  npm run realistic-load-test 20 60000           # 20 connections, 60s
  npm run realistic-load-test 20 60000 50        # 20 connections, 60s, 50ms interval

This simulates realistic application database operations:
- User profile lookups (30%)
- Level listings (25%)
- Score lookups (20%)
- Player statistics (15%)
- Leaderboard queries (10%)

Helps identify:
- Real-world connection pool performance
- Query-specific performance issues
- Optimal pool configuration for your app
- Database bottlenecks
    `);
  } else {
    runRealisticLoadTest();
  }
} 