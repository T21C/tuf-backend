import type { JsonSchema } from '@/server/middleware/apiDoc.js';

/**
 * Response type for GET /v2/health
 */
export interface HealthCheckResponse {
  status: 'online' | 'degraded' | 'offline';
  timestamp: string;
  checks: {
    database: { connected: boolean; message: string };
    socket: { connected: boolean; message: string };
  };
  system: {
    uptime: number;
    memory: { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number };
    nodeVersion: string;
    platform: string;
    env: string;
  };
}

/** JSON Schema for health check 200 response – use in ApiDoc({ responses: { 200: { schema: healthCheckResponseSchema } } }) */
export const healthCheckResponseSchema: JsonSchema = {
  type: 'object',
  description: 'Service status and checks',
  properties: {
    status: { type: 'string', enum: ['online', 'degraded', 'offline'], description: 'Overall status' },
    timestamp: { type: 'string', description: 'ISO timestamp' },
    checks: {
      type: 'object',
      properties: {
        database: { type: 'object', properties: { connected: { type: 'boolean' }, message: { type: 'string' } }, required: ['connected', 'message'] },
        socket: { type: 'object', properties: { connected: { type: 'boolean' }, message: { type: 'string' } }, required: ['connected', 'message'] },
      },
      required: ['database', 'socket'],
    },
    system: {
      type: 'object',
      properties: {
        uptime: { type: 'number' },
        memory: {
          type: 'object',
          properties: { rss: { type: 'number' }, heapTotal: { type: 'number' }, heapUsed: { type: 'number' }, external: { type: 'number' }, arrayBuffers: { type: 'number' } },
        },
        nodeVersion: { type: 'string' },
        platform: { type: 'string' },
        env: { type: 'string' },
      },
      required: ['uptime', 'nodeVersion', 'platform', 'env'],
    },
  },
  required: ['status', 'timestamp', 'checks', 'system'],
};

/** JSON Schema for health 500 response */
export const healthErrorResponseSchema: JsonSchema = {
  type: 'object',
  description: 'Service offline or error',
  properties: {
    status: { type: 'string', enum: ['offline'] },
    timestamp: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['status', 'timestamp', 'error'],
};
