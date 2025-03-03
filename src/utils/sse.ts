import {Response} from 'express';

interface SSEClient {
  id: string;
  res: Response;
  lastPing?: number;
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
      this.clients.forEach((client, clientId) => {
        try {
          // Send ping to client
          client.res.write(`data: ${JSON.stringify({type: 'ping'})}\n\n`);
          client.lastPing = now;
        } catch (error) {
          console.debug(
            `SSE: Error sending heartbeat to client ${clientId}, removing client`,
          );
          this.removeClient(clientId);
        }
      });

      // Clean up stale clients
      this.clients.forEach((client, clientId) => {
        if (client.lastPing && now - client.lastPing > this.CLIENT_TIMEOUT) {
          console.debug(`SSE: Client ${clientId} timed out, removing`);
          this.removeClient(clientId);
        }
      });
    }, this.HEARTBEAT_INTERVAL);
  }

  private broadcastUserCount() {
    this.broadcast({
      type: 'userCount',
      data: {
        count: this.getClientCount()
      }
    });
  }

  addClient(res: Response): string {
    const clientId = Math.random().toString(36).substring(7);

    // Send initial connection message
    res.write(`data: ${JSON.stringify({type: 'connected', clientId})}\n\n`);

    this.clients.set(clientId, {
      id: clientId,
      res,
      lastPing: Date.now(),
    });

    // Broadcast updated user count
    this.broadcastUserCount();

    res.on('close', () => {
      //console.debug(`SSE: Client ${clientId} connection closed`);
      this.removeClient(clientId);
    });

    return clientId;
  }

  removeClient(clientId: string) {
    const client = this.clients.get(clientId);
    if (client) {
      try {
        client.res.end();
      } catch (error) {
        console.debug(`SSE: Error ending response for client ${clientId}`);
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
        console.debug(`SSE: Error broadcasting to client ${clientId}`);
        failedClients.push(clientId);
      }
    });

    // Clean up failed clients after iteration
    failedClients.forEach(clientId => this.removeClient(clientId));
  }

  getClientCount(): number {
    return this.clients.size;
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
