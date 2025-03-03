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
      const stats = this.getConnectionStats();
      console.debug(`SSE: Starting heartbeat check. Current clients: ${stats.total} (${stats.managers} managers)`);
      
      this.clients.forEach((client, clientId) => {
        try {
          // Send ping to client
          client.res.write(`data: ${JSON.stringify({type: 'ping'})}\n\n`);
          client.lastPing = now;
        } catch (error) {
          console.debug(
            `SSE: Error sending heartbeat to client ${clientId} (${client.metadata.isManager ? 'manager' : 'user'})`,
            {
              userId: client.metadata.userId,
              source: client.metadata.source
            }
          );
          this.removeClient(clientId);
        }
      });

      // Clean up stale clients
      this.clients.forEach((client, clientId) => {
        if (client.lastPing && now - client.lastPing > this.CLIENT_TIMEOUT) {
          console.debug(`SSE: Client ${clientId} timed out after ${Math.floor((now - client.lastPing) / 1000)}s`, {
            userId: client.metadata.userId,
            source: client.metadata.source,
            isManager: client.metadata.isManager
          });
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
        .filter(client => client.metadata.userId) // Filter out undefined userIds
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

    // Track connections by source (keeping this as total connections for debugging)
    const bySource = clients.reduce((acc, client) => {
      const src = client.metadata.source;
      acc[src] = (acc[src] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    // Add detailed stats for debugging
    const details = {
      totalConnections: filteredClients.length,
      uniqueUsers: total,
      uniqueManagers: managers,
      bySource,
      userIds: Array.from(uniqueUsers),
      managerIds: Array.from(uniqueManagers)
    };

    console.debug('SSE: Connection stats details:', details);

    return { total, managers, bySource, details };
  }

  private broadcastUserCount() {
    // Get stats for all connections and rating-specific connections
    const allStats = this.getConnectionStats();
    const ratingStats = this.getConnectionStats('rating');
    
    console.debug('SSE: Broadcasting user count', {
      all: {
        total: allStats.total,
        managers: allStats.managers,
        bySource: allStats.bySource
      },
      rating: {
        total: ratingStats.total,
        managers: ratingStats.managers,
        bySource: ratingStats.bySource
      }
    });

    // Log detailed connection state for debugging
    console.debug('SSE: Current connections:', Array.from(this.clients.entries()).map(([id, client]) => ({
      id,
      userId: client.metadata.userId,
      source: client.metadata.source,
      isManager: client.metadata.isManager,
      lastPing: client.lastPing ? Math.floor((Date.now() - client.lastPing) / 1000) + 's ago' : 'never'
    })));
    
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
    console.debug(`SSE: Adding new client ${clientId}`, metadata);

    // Send initial connection message
    res.write(`data: ${JSON.stringify({type: 'connected', clientId})}\n\n`);

    this.clients.set(clientId, {
      id: clientId,
      res,
      lastPing: Date.now(),
      metadata
    });

    // Log current state after adding client
    const stats = this.getConnectionStats(metadata.source);
    console.debug(`SSE: Client ${clientId} added. Current state for ${metadata.source}:`, stats);

    // Broadcast updated user count
    this.broadcastUserCount();

    return clientId;
  }

  removeClient(clientId: string) {
    const client = this.clients.get(clientId);
    if (client) {
      console.debug(`SSE: Removing client ${clientId}`, {
        userId: client.metadata.userId,
        source: client.metadata.source,
        isManager: client.metadata.isManager
      });
      
      try {
        client.res.end();
      } catch (error) {
        console.debug(`SSE: Error ending response for client ${clientId}`);
      }
      this.clients.delete(clientId);
      
      // Log current state after removing client
      const stats = this.getConnectionStats(client.metadata.source);
      console.debug(`SSE: Client ${clientId} removed. Current state for ${client.metadata.source}:`, stats);
      
      // Broadcast updated user count after removing client
      this.broadcastUserCount();
    }
  }

  broadcast(event: {type: string; data?: any}) {
    const stats = this.getConnectionStats();
    const failedClients: string[] = [];
    console.debug(`SSE: Broadcasting event type "${event.type}" to ${stats.total} clients`);

    this.clients.forEach((client, clientId) => {
      try {
        client.res.write(`data: ${JSON.stringify(event)}\n\n`);
        client.lastPing = Date.now(); // Update last ping time on successful broadcast
      } catch (error) {
        console.debug(`SSE: Error broadcasting to client ${clientId}`, {
          userId: client.metadata.userId,
          source: client.metadata.source,
          isManager: client.metadata.isManager
        });
        failedClients.push(clientId);
      }
    });

    if (failedClients.length > 0) {
      console.debug(`SSE: Failed to broadcast to ${failedClients.length} clients, removing them`);
    }

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
    console.debug('SSE: Cleaning up all connections');
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.clients.forEach((client, clientId) => this.removeClient(clientId));
    this.clients.clear();
  }
}

export const sseManager = new SSEManager();
