import {Response} from 'express';

interface ClientMetadata {
  userId: string;
  source: string;
  isManager: boolean;
}

interface SSEClient {
  id: string;
  res: Response;
  lastPing?: number;
  metadata: ClientMetadata;
}

class SSEManager {
  private clients: Map<string, SSEClient> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private readonly CLIENT_TIMEOUT = 60000; // 60 seconds

  constructor() {
    this.startHeartbeat();
  }

  private startHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const ratingStats = this.getConnectionStats('rating');
      
      this.clients.forEach((client, clientId) => {
        try {
          // Send ping to client
          client.res.write(`data: ${JSON.stringify({type: 'ping'})}\n\n`);
          client.lastPing = now;
        } catch (error) {
          this.removeClient(clientId);
        }
      });

      // Clean up stale clients
      this.clients.forEach((client, clientId) => {
        if (client.lastPing && now - client.lastPing > this.CLIENT_TIMEOUT) {
          this.removeClient(clientId);
        }
      });
    }, this.HEARTBEAT_INTERVAL);
  }

  private getConnectionStats(source?: string) {
    const clients = Array.from(this.clients.values());
    const filteredClients = source 
      ? clients.filter(client => client.metadata.source === source)
      : clients;

    // Get unique users by userId
    const uniqueUsers = new Set(
      filteredClients
        .filter(client => client.metadata.userId)
        .map(client => client.metadata.userId)
    );

    // Get unique managers by userId
    const uniqueManagers = new Set(
      filteredClients
        .filter(client => client.metadata.isManager && client.metadata.userId)
        .map(client => client.metadata.userId)
    );

    const total = uniqueUsers.size;
    const managers = uniqueManagers.size;

    // Track connections by source
    const bySource = clients.reduce((acc, client) => {
      const src = client.metadata.source;
      acc[src] = (acc[src] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    return { total, managers, bySource };
  }

  private broadcastUserCount() {
    // Get stats for rating-specific connections only
    const ratingStats = this.getConnectionStats('rating');
    
    // Broadcast only rating-specific counts to clients
    this.broadcast({
      type: 'userCount',
      data: {
        total: ratingStats.total,
        managers: ratingStats.managers
      }
    });
  }

  addClient(res: Response, metadata: ClientMetadata): string {
    const clientId = Math.random().toString(36).substring(7);

    // Send initial connection message
    res.write(`data: ${JSON.stringify({type: 'connected', clientId})}\n\n`);

    this.clients.set(clientId, {
      id: clientId,
      res,
      lastPing: Date.now(),
      metadata
    });

    // Broadcast updated user count
    this.broadcastUserCount();

    return clientId;
  }

  removeClient(clientId: string) {
    const client = this.clients.get(clientId);
    if (client) {
      try {
        client.res.end();
      } catch (error) {
        // Silently handle error
      }
      this.clients.delete(clientId);
      
      // Broadcast updated user count after removing client
      this.broadcastUserCount();
    }
  }

  broadcast(event: {type: string; data?: any}) {
    const failedClients: string[] = [];

    this.clients.forEach((client, clientId) => {
      try {
        client.res.write(`data: ${JSON.stringify(event)}\n\n`);
        client.lastPing = Date.now(); // Update last ping time on successful broadcast
      } catch (error) {
        failedClients.push(clientId);
      }
    });

    // Clean up failed clients after iteration
    failedClients.forEach(clientId => this.removeClient(clientId));
  }

  getClientCount(source?: string): number {
    return this.getConnectionStats(source).total;
  }

  getManagerCount(source?: string): number {
    return this.getConnectionStats(source).managers;
  }

  cleanup() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.clients.forEach((client, clientId) => this.removeClient(clientId));
    this.clients.clear();
  }
}

export const sseManager = new SSEManager();
