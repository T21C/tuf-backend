import { Response } from 'express';

class SSEManager {
  private clients: Set<Response> = new Set();

  addClient(client: Response) {
    this.clients.add(client);
    client.on('close', () => {
      this.clients.delete(client);
    });
  }

  broadcast(event: { type: string; data?: any }) {
    this.clients.forEach(client => {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    });
  }
}

export const sseManager = new SSEManager(); 