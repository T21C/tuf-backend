import {Response} from 'express';
import {logger} from '@/server/services/core/LoggerService.js';
import {redis} from '@/server/services/core/RedisService.js';

export const SSE_NOTIFICATIONS_CHANNEL = 'sse:notifications';

export const SSE_SOURCES = {
  rating: 'rating',
  admin: 'admin',
  announcement: 'announcement',
  submission: 'submission',
  inbox: 'inbox',
} as const;

interface ClientMetadata {
  userId: string | null;
  source: string;
  isManager: boolean;
}

interface SSEClient {
  id: string;
  res: Response;
  lastPing?: number;
  metadata: ClientMetadata;
}

export interface SSEEvent {
  type: string;
  data?: unknown;
}

class SSEManager {
  private clients: Map<string, SSEClient> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private readonly CLIENT_TIMEOUT = 60000; // 60 seconds
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private subscriber: any = null;

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
    const ratingStats = this.getConnectionStats(SSE_SOURCES.rating);

    this.broadcastToSources([SSE_SOURCES.rating], {
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

  broadcast(event: SSEEvent) {
    this.writeToClients(event, () => true);
  }

  broadcastToSources(sources: readonly string[], event: SSEEvent) {
    if (!sources.length) return;
    const allowed = new Set<string>(sources);
    this.writeToClients(event, (client) => allowed.has(client.metadata.source));
  }

  sendToUser(userId: string, event: SSEEvent): void {
    if (!userId) return;
    this.writeToClients(
      event,
      (client) =>
        client.metadata.userId === userId && client.metadata.source === SSE_SOURCES.inbox,
    );
  }

  /**
   * Publish to Redis so every API process can push to its local SSE clients.
   * If Redis is unavailable, deliver locally only.
   */
  async fanoutToUser(userId: string, event: SSEEvent): Promise<void> {
    if (!userId) return;
    if (this.subscriber) {
      const published = await redis.publish(
        SSE_NOTIFICATIONS_CHANNEL,
        JSON.stringify({userId, event}),
      );
      if (published) return;
    }
    this.sendToUser(userId, event);
  }

  async startRedisFanout(): Promise<void> {
    if (this.subscriber) return;
    const sub = await redis.createSubscriberClient();
    if (!sub) {
      logger.warn('[sse] Redis subscriber unavailable; inbox fan-out is local-only');
      return;
    }

    await sub.subscribe(SSE_NOTIFICATIONS_CHANNEL, (message: string) => {
      try {
        const parsed = JSON.parse(message) as {userId?: string; event?: SSEEvent};
        if (!parsed?.userId || !parsed.event) return;
        this.sendToUser(parsed.userId, parsed.event);
      } catch (error) {
        logger.warn('[sse] Failed to parse inbox fan-out message', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.subscriber = sub;
    logger.info('[sse] Redis inbox fan-out subscribed');
  }

  async stopRedisFanout(): Promise<void> {
    if (!this.subscriber) return;
    try {
      await this.subscriber.unsubscribe(SSE_NOTIFICATIONS_CHANNEL);
      await this.subscriber.quit();
    } catch (error) {
      logger.debug('[sse] Redis subscriber quit failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    this.subscriber = null;
  }

  private writeToClients(
    event: SSEEvent,
    predicate: (client: SSEClient) => boolean,
  ): void {
    const failedClients: string[] = [];
    const payload = `data: ${JSON.stringify(event)}\n\n`;

    this.clients.forEach((client, clientId) => {
      if (!predicate(client)) return;
      try {
        client.res.write(payload);
        client.lastPing = Date.now();
      } catch {
        failedClients.push(clientId);
      }
    });

    failedClients.forEach((clientId) => this.removeClient(clientId));
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
    void this.stopRedisFanout();
    this.clients.forEach((client, clientId) => this.removeClient(clientId));
    this.clients.clear();
  }
}

export const sseManager = new SSEManager();
