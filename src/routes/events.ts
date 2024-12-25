import { Router } from 'express';
import { Auth } from '../middleware/auth';
import { sseManager } from '../utils/sse';

const router: Router = Router();

router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Add this client to the SSE manager
  sseManager.addClient(res);

  // Send an initial ping to establish the connection
  res.write('data: {"type":"ping"}\n\n');

  // Keep the connection alive with a ping every 30 seconds
  const pingInterval = setInterval(() => {
    res.write('data: {"type":"ping"}\n\n');
  }, 30000);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(pingInterval);
  });
});

export default router; 