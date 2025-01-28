import { Router } from 'express';
import { sseManager } from '../utils/sse';

const router: Router = Router();

// SSE endpoint
router.get('/', (req, res) => {
  console.log('New SSE connection request from:', req.ip);
  console.log('Headers:', req.headers);
  
  // Set SSE headers after CORS middleware has run
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Disable response buffering
  res.flushHeaders();
  
  // Keep the connection alive
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
    console.log('Sent keepalive to:', req.ip);
  }, 30000);

  // Add client to SSE manager
  const clientId = sseManager.addClient(res);
  console.log('Added SSE client:', clientId);

  // Clean up on connection close
  res.on('close', () => {
    console.log('SSE connection closed for client:', clientId);
    clearInterval(keepAlive);
    sseManager.removeClient(clientId);
  });
});

export default router; 