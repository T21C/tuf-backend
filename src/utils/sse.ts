import { Response } from 'express';

interface SSEClient {
  id: string;
  res: Response;
}

class SSEManager {
  private clients: Map<string, SSEClient> = new Map();

  addClient(res: Response): string {
    const clientId = Math.random().toString(36).substring(7);
    this.clients.set(clientId, { id: clientId, res });
    
    res.on('close', () => {
      this.removeClient(clientId);
    });

    return clientId;
  }

  removeClient(clientId: string) {
    this.clients.delete(clientId);
  }

  broadcast(event: { type: string; data?: any }) {
    this.clients.forEach(client => {
      try {
        client.res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (error) {
        console.error(`Error broadcasting to client ${client.id}:`, error);
        this.removeClient(client.id);
      }
    });
  }

  getClientCount(): number {
    return this.clients.size;
  }
}

export const sseManager = new SSEManager(); 