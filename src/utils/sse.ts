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
      console.debug(`SSE: Starting heartbeat check for rating page. Connected: ${ratingStats.total} (${ratingStats.managers} managers)`);
      
      this.clients.forEach((client, clientId) => {
        try {
          // Send ping to client
          client.res.write(`data: ${JSON.stringify({type: 'ping'})}\n\n`);
          client.lastPing = now;
        } catch (error) {
          if (client.metadata.source === 'rating') {
            console.debug(
              `SSE Rating: Error sending heartbeat to client ${clientId} (${client.metadata.isManager ? 'manager' : 'user'})`,
              {
                userId: client.metadata.userId
              }
            );
          }
          this.removeClient(clientId);
        }
      });

      // Clean up stale clients
      this.clients.forEach((client, clientId) => {
        if (client.lastPing && now - client.lastPing > this.CLIENT_TIMEOUT) {
          if (client.metadata.source === 'rating') {
            console.debug(`SSE Rating: Client ${clientId} timed out after ${Math.floor((now - client.lastPing) / 1000)}s`, {
              userId: client.metadata.userId,
              isManager: client.metadata.isManager
            });
          }
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

    // Track connections by source (keeping this as total connections for debugging)
    const bySource = clients.reduce((acc, client) => {
      const src = client.metadata.source;
      acc[src] = (acc[src] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    // Only log detailed stats for rating source
    if (source === 'rating') {
      console.debug('SSE Rating: Connection stats:', {
        uniqueUsers: total,
        uniqueManagers: managers,
        userIds: Array.from(uniqueUsers),
        managerIds: Array.from(uniqueManagers)
      });
    }

    return { total, managers, bySource };
  }

  private broadcastUserCount() {
    // Get stats for rating-specific connections only
    const ratingStats = this.getConnectionStats('rating');
    
    if (ratingStats.total > 0) {
      console.debug('SSE Rating: Broadcasting user count', {
        total: ratingStats.total,
        managers: ratingStats.managers
      });

      // Log detailed connection state for rating clients only
      const ratingClients = Array.from(this.clients.entries())
        .filter(([_, client]) => client.metadata.source === 'rating')
        .map(([id, client]) => ({
          id,
          userId: client.metadata.userId,
          isManager: client.metadata.isManager,
          lastPing: client.lastPing ? Math.floor((Date.now() - client.lastPing) / 1000) + 's ago' : 'never'
        }));

      if (ratingClients.length > 0) {
        console.debug('SSE Rating: Current connections:', ratingClients);
      }
    }
    
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
    
    if (metadata.source === 'rating') {
      console.debug(`SSE Rating: Adding new client ${clientId}`, {
        userId: metadata.userId,
        isManager: metadata.isManager
      });
    }

    // Send initial connection message
    res.write(`data: ${JSON.stringify({type: 'connected', clientId})}\n\n`);

    this.clients.set(clientId, {
      id: clientId,
      res,
      lastPing: Date.now(),
      metadata
    });

    // Log current state after adding rating client
    if (metadata.source === 'rating') {
      const stats = this.getConnectionStats('rating');
      console.debug(`SSE Rating: Client ${clientId} added. Current state:`, {
        total: stats.total,
        managers: stats.managers
      });
    }

    // Broadcast updated user count
    this.broadcastUserCount();

    return clientId;
  }

  removeClient(clientId: string) {
    const client = this.clients.get(clientId);
    if (client) {
      if (client.metadata.source === 'rating') {
        console.debug(`SSE Rating: Removing client ${clientId}`, {
          userId: client.metadata.userId,
          isManager: client.metadata.isManager
        });
      }
      
      try {
        client.res.end();
      } catch (error) {
        if (client.metadata.source === 'rating') {
          console.debug(`SSE Rating: Error ending response for client ${clientId}`);
        }
      }
      this.clients.delete(clientId);
      
      // Log current state after removing rating client
      if (client.metadata.source === 'rating') {
        const stats = this.getConnectionStats('rating');
        console.debug(`SSE Rating: Client ${clientId} removed. Current state:`, {
          total: stats.total,
          managers: stats.managers
        });
      }
      
      // Broadcast updated user count after removing client
      this.broadcastUserCount();
    }
  }

  broadcast(event: {type: string; data?: any}) {
    const ratingStats = this.getConnectionStats('rating');
    const failedClients: string[] = [];

    if (ratingStats.total > 0) {
      console.debug(`SSE Rating: Broadcasting event type "${event.type}" to ${ratingStats.total} clients`);
    }

    this.clients.forEach((client, clientId) => {
      try {
        client.res.write(`data: ${JSON.stringify(event)}\n\n`);
        client.lastPing = Date.now(); // Update last ping time on successful broadcast
      } catch (error) {
        if (client.metadata.source === 'rating') {
          console.debug(`SSE Rating: Error broadcasting to client ${clientId}`, {
            userId: client.metadata.userId,
            isManager: client.metadata.isManager
          });
        }
        failedClients.push(clientId);
      }
    });

    if (failedClients.length > 0) {
      const ratingFailures = failedClients.filter(id => 
        this.clients.get(id)?.metadata.source === 'rating'
      );
      if (ratingFailures.length > 0) {
        console.debug(`SSE Rating: Failed to broadcast to ${ratingFailures.length} rating clients`);
      }
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
