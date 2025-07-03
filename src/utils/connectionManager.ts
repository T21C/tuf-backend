import { killAllConnections, refreshConnectionPool, getConnectionStats } from '../config/db.js';

/**
 * Utility class for managing database connections
 */
export class ConnectionManager {
  /**
   * Kill all existing database connections except the current one
   */
  static async killConnections(): Promise<void> {
    console.log('Killing all existing connections...');
    await killAllConnections();
  }

  /**
   * Refresh the connection pool by closing and reinitializing it
   */
  static async refreshPool(): Promise<void> {
    console.log('Refreshing connection pool...');
    await refreshConnectionPool();
  }

  /**
   * Get current connection statistics
   */
  static async getStats(): Promise<any> {
    const stats = await getConnectionStats();
    console.log('Connection stats:', stats);
    return stats;
  }

  /**
   * Perform a complete connection reset
   */
  static async resetConnections(): Promise<void> {
    console.log('Performing complete connection reset...');
    
    // Step 1: Kill all existing connections
    await this.killConnections();
    
    // Step 2: Wait a moment for connections to close
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Step 3: Refresh the connection pool
    await this.refreshPool();
    
    // Step 4: Get stats to verify
    await this.getStats();
    
    console.log('Connection reset completed');
  }

  /**
   * Monitor connections and reset if needed
   */
  static async monitorAndReset(): Promise<void> {
    const stats = await this.getStats();
    
    if (stats && stats.total_connections > 15) {
      console.log(`High connection count detected (${stats.total_connections}), resetting...`);
      await this.resetConnections();
    } else {
      console.log('Connection count is normal');
    }
  }
}

// CLI usage example
if (require.main === module) {
  const command = process.argv[2];
  
  switch (command) {
    case 'kill':
      ConnectionManager.killConnections();
      break;
    case 'refresh':
      ConnectionManager.refreshPool();
      break;
    case 'stats':
      ConnectionManager.getStats();
      break;
    case 'reset':
      ConnectionManager.resetConnections();
      break;
    case 'monitor':
      ConnectionManager.monitorAndReset();
      break;
    default:
      console.log(`
Usage: node connectionManager.js [command]

Commands:
  kill     - Kill all existing connections
  refresh  - Refresh the connection pool
  stats    - Show connection statistics
  reset    - Complete connection reset (kill + refresh)
  monitor  - Monitor and reset if needed
      `);
  }
} 