import { Router } from 'express';
import { sseManager } from '../utils/sse';

const router: Router = Router();

// SSE endpoint
router.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  
  res.flushHeaders();
  
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  const clientId = sseManager.addClient(res);

  res.on('close', () => {
    clearInterval(keepAlive);
    sseManager.removeClient(clientId);
  });
});

export default router; 