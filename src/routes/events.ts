import { Router } from 'express';
import { sseManager } from '../utils/sse';

const router: Router = Router();

// SSE endpoint
router.get('/', (req, res) => {
  // Set SSE headers after CORS middleware has run
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Disable response buffering
  res.flushHeaders();
  
  // Keep the connection alive
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);

  // Add client to SSE manager
  const clientId = sseManager.addClient(res);

  // Clean up on connection close
  res.on('close', () => {
    clearInterval(keepAlive);
    sseManager.removeClient(clientId);
  });
});

export default router; 