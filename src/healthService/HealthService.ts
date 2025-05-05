import express from 'express';
import http from 'http';
import axios from 'axios';
import sequelize from '../config/db.js';
import v8 from 'v8';
import { logger } from '../services/LoggerService.js';

export class HealthService {
  private static instance: HealthService;
  private app: express.Application;
  private server: http.Server | null = null;
  private port: number = 3883; // Fixed port for the health service
  private mainServerPort: number;
  private mainServerUrl: string;
  private isRunning: boolean = false;
  private startTime: Date | null = null;
  private lastCheckTime: Date | null = null;
  private status: 'online' | 'degraded' | 'offline' = 'online';
  private checks: Record<string, boolean> = {
    database: false,
    mainServer: false
  };
  private checkInterval: NodeJS.Timeout | null = null;
  private mainServerInfo: any = null;

  private constructor() {
    this.app = express();
    this.mainServerPort = process.env.NODE_ENV === 'production' ? 3000 : 3002;
    this.mainServerUrl = `http://localhost:${this.mainServerPort}`;
    this.setupRoutes();
  }

  public static getInstance(): HealthService {
    if (!HealthService.instance) {
      HealthService.instance = new HealthService();
    }
    return HealthService.instance;
  }

  private setupRoutes(): void {
    // HTML status page
    this.app.get('/health', (req, res) => {
      const uptime = this.startTime ? this.getUptime() : 'Not started';
      const lastCheck = this.lastCheckTime ? this.lastCheckTime.toISOString() : 'Never';
      
      // Format memory usage for display
      const formatMemory = (bytes: number) => {
        const mb = bytes / (1024 * 1024);
        return `${mb.toFixed(2)} MB`;
      };
      
      // Format uptime for display
      const formatUptime = (seconds: number) => {
        const days = Math.floor(seconds / (24 * 60 * 60));
        const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
        const minutes = Math.floor((seconds % (60 * 60)) / 60);
        const secs = Math.floor(seconds % 60);
        
        return `${days}d ${hours}h ${minutes}m ${secs}s`;
      };
      
      // Get main server info if available
      const mainServerUptime = this.mainServerInfo?.system?.uptime 
        ? formatUptime(this.mainServerInfo.system.uptime) 
        : 'Unknown';
      
      const mainServerMemory = this.mainServerInfo?.system?.memory 
        ? {
            rss: formatMemory(this.mainServerInfo.system.memory.rss),
            heapTotal: formatMemory(this.mainServerInfo.system.memory.heapTotal),
            heapUsed: formatMemory(this.mainServerInfo.system.memory.heapUsed),
            external: formatMemory(this.mainServerInfo.system.memory.external),
            arrayBuffers: formatMemory(this.mainServerInfo.system.memory.arrayBuffers)
          }
        : null;
      
      const mainServerStatus = this.mainServerInfo?.status || 'Unknown';
      const mainServerEnv = this.mainServerInfo?.system?.env || 'Unknown';
      const mainServerNodeVersion = this.mainServerInfo?.system?.nodeVersion || 'Unknown';
      const mainServerPlatform = this.mainServerInfo?.system?.platform || 'Unknown';
      
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Health Status</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              max-width: 800px;
              margin: 0 auto;
              padding: 20px;
              line-height: 1.6;
            }
            h1 {
              color: ${this.getStatusColor()};
            }
            .status {
              font-weight: bold;
              color: ${this.getStatusColor()};
            }
            .check {
              margin: 10px 0;
              padding: 10px;
              border-radius: 4px;
              background-color: #f5f5f5;
            }
            .check.online {
              border-left: 4px solid #4CAF50;
            }
            .check.offline {
              border-left: 4px solid #F44336;
            }
            .check.degraded {
              border-left: 4px solid #FF9800;
            }
            .info {
              margin-top: 20px;
              padding: 15px;
              background-color: #e9f7fe;
              border-radius: 4px;
            }
            .resource-info {
              margin-top: 20px;
              padding: 15px;
              background-color: #f0f8f0;
              border-radius: 4px;
            }
            .resource-info h3 {
              margin-top: 0;
              color: #2E7D32;
            }
            .resource-grid {
              display: grid;
              grid-template-columns: repeat(2, 1fr);
              gap: 10px;
            }
            .resource-item {
              padding: 8px;
              background-color: #fff;
              border-radius: 4px;
              box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            }
            .resource-label {
              font-weight: bold;
              color: #555;
            }
            .resource-value {
              color: #333;
            }
            .timestamp {
              font-size: 0.8em;
              color: #666;
              margin-top: 10px;
            }
          </style>
        </head>
        <body>
          <h1>Health Status: <span class="status">${this.status.toUpperCase()}</span></h1>
          
          <div class="info">
            <p><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</p>
            <p><strong>Health Service Port:</strong> ${this.port}</p>
            <p><strong>Main Server URL:</strong> ${this.mainServerUrl}</p>
            <p><strong>Uptime:</strong> ${uptime}</p>
            <p><strong>Last Check:</strong> ${lastCheck}</p>
          </div>
          
          <h2>Component Status</h2>
          
          <div class="check ${this.checks.database ? 'online' : 'offline'}">
            <p><strong>Database:</strong> ${this.checks.database ? 'Connected' : 'Disconnected'}</p>
          </div>
          
          <div class="check ${this.checks.mainServer ? 'online' : 'offline'}">
            <p><strong>Main Server:</strong> ${this.checks.mainServer ? 'Running' : 'Not Running'}</p>
            <p><strong>Status:</strong> <span style="color: ${this.getStatusColorForServer(mainServerStatus)}">${mainServerStatus.toUpperCase()}</span></p>
          </div>
          
          ${this.mainServerInfo ? `
          <div class="resource-info">
            <h3>Main Server Resources</h3>
            <div class="resource-grid">
              <div class="resource-item">
                <div class="resource-label">Uptime</div>
                <div class="resource-value">${mainServerUptime}</div>
              </div>
              <div class="resource-item">
                <div class="resource-label">Environment</div>
                <div class="resource-value">${mainServerEnv}</div>
              </div>
              <div class="resource-item">
                <div class="resource-label">Node Version</div>
                <div class="resource-value">${mainServerNodeVersion}</div>
              </div>
              <div class="resource-item">
                <div class="resource-label">Platform</div>
                <div class="resource-value">${mainServerPlatform}</div>
              </div>
            </div>
            
            <h3>Memory Usage</h3>
            <div class="resource-grid">
              <div class="resource-item">
                <div class="resource-label">RSS</div>
                <div class="resource-value">${mainServerMemory?.rss || 'Unknown'}</div>
              </div>
              <div class="resource-item">
                <div class="resource-label">Heap Total</div>
                <div class="resource-value">${mainServerMemory?.heapTotal || 'Unknown'}</div>
              </div>
              <div class="resource-item">
                <div class="resource-label">Heap Used</div>
                <div class="resource-value">${mainServerMemory?.heapUsed || 'Unknown'}</div>
              </div>
              <div class="resource-item">
                <div class="resource-label">External</div>
                <div class="resource-value">${mainServerMemory?.external || 'Unknown'}</div>
              </div>
              <div class="resource-item">
                <div class="resource-label">Array Buffers</div>
                <div class="resource-value">${mainServerMemory?.arrayBuffers || 'Unknown'}</div>
              </div>
            </div>
            
            <div class="timestamp">
              Last updated: ${this.lastCheckTime ? new Date(this.lastCheckTime).toLocaleString() : 'Never'}
            </div>
          </div>
          ` : ''}
          
          <script>
            // Auto-refresh the page every 5 seconds
            setTimeout(() => {
              window.location.reload();
            }, 5000);
          </script>
        </body>
        </html>
      `);
    });

    // JSON API endpoint for health checks with CORS headers
    this.app.get('/health/api', (req, res) => {
      // Set CORS headers to allow all origins
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      
      // Handle preflight requests
      if (req.method === 'OPTIONS') {
        return res.status(200).end();
      }
      
      this.lastCheckTime = new Date();
      this.runHealthChecks();
      
      // Get memory limits
      const v8Stats = v8.getHeapStatistics();
      const memoryUsage = process.memoryUsage();
      
      // Calculate memory limits
      const memoryLimits = {
        heapSizeLimit: v8Stats.heap_size_limit,
        totalAvailableSize: v8Stats.total_available_size,
        totalHeapSizeExecutable: v8Stats.total_heap_size_executable,
        totalPhysicalSize: v8Stats.total_physical_size,
        // maxRSS is in KB, convert to bytes for consistency with other memory values
        rssLimit: process.resourceUsage().maxRSS ? process.resourceUsage().maxRSS * 1024 : 'Unknown'
      };
      
      return res.json({
        status: this.status,
        timestamp: this.lastCheckTime.toISOString(),
        uptime: this.getUptime(),
        checks: this.checks,
        mainServerInfo: this.mainServerInfo,
        memoryLimits: memoryLimits,
        memoryUsage: memoryUsage
      });
    });
  }

  private getStatusColor(): string {
    switch (this.status) {
      case 'online':
        return '#4CAF50';
      case 'degraded':
        return '#FF9800';
      case 'offline':
        return '#F44336';
      default:
        return '#000000';
    }
  }
  
  private getStatusColorForServer(status: string): string {
    switch (status) {
      case 'online':
        return '#4CAF50';
      case 'degraded':
        return '#FF9800';
      case 'offline':
        return '#F44336';
      default:
        return '#000000';
    }
  }

  private getUptime(): string {
    if (!this.startTime) return 'Not started';
    
    const uptimeMs = Date.now() - this.startTime.getTime();
    const seconds = Math.floor((uptimeMs / 1000) % 60);
    const minutes = Math.floor((uptimeMs / (1000 * 60)) % 60);
    const hours = Math.floor((uptimeMs / (1000 * 60 * 60)) % 24);
    const days = Math.floor(uptimeMs / (1000 * 60 * 60 * 24));
    
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }

  private async checkMainServer(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.mainServerUrl}/health`, {
        timeout: 5000 // 5 second timeout
      });
      
      // Store the main server info for display
      this.mainServerInfo = response.data;
      
      return response.status === 200;
    } catch (error) {
      console.error(`Main server health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      this.mainServerInfo = null;
      return false;
    }
  }

  private async runHealthChecks(): Promise<void> {
    // Check database connection
    try {
      await sequelize.authenticate();
      this.checks.database = true;
    } catch (error) {
      console.error('Database health check failed:', error);
      this.checks.database = false;
    }
    
    // Check main server
    this.checks.mainServer = await this.checkMainServer();
    
    // Determine overall status
    const offlineCount = Object.values(this.checks).filter(check => !check).length;
    
    if (offlineCount === 0) {
      this.status = 'online';
    } else if (offlineCount === 1) {
      this.status = 'degraded';
    } else {
      this.status = 'offline';
    }
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('Health service is already running');
      return;
    }
    
    try {
      // Create server with both IPv4 and IPv6 support
      this.server = http.createServer(this.app);
      
      // Listen on both IPv4 and IPv6
      this.server.listen(this.port, '::', () => {
        this.isRunning = true;
        this.startTime = new Date();
        console.log(`Health service listening on port ${this.port} (IPv4 and IPv6)`);
        console.log(`Monitoring main server at ${this.mainServerUrl}`);
      });
      
      // Run initial health check
      await this.runHealthChecks();
      
      // Set up periodic health checks (every 5 seconds)
      this.checkInterval = setInterval(async () => {
        await this.runHealthChecks();
      }, 5000);
    } catch (error) {
      console.error('Failed to start health service:', error);
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning || !this.server) {
      console.warn('Health service is not running');
      return;
    }
    
    try {
      // Clear the check interval
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
        this.checkInterval = null;
      }
      
      await new Promise<void>((resolve) => {
        this.server?.close(() => {
          this.isRunning = false;
          this.server = null;
          console.log('Health service stopped');
          resolve();
        });
      });
    } catch (error) {
      console.error('Error stopping health service:', error);
    }
  }

  public getStatus(): 'online' | 'degraded' | 'offline' {
    return this.status;
  }

  public isServiceRunning(): boolean {
    return this.isRunning;
  }
} 