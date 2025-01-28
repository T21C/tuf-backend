import { Router } from 'express';
import { sseManager } from '../utils/sse';

const router: Router = Router();

// SSE endpoint
router.get('/', (req, res) => {
  console.log('New SSE connection request from:', req.ip);
  console.log('Headers:', req.headers);
  console.log('Environment:', process.env.NODE_ENV);
  
  // Set SSE headers after CORS middleware has run
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Add additional headers for production environment
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  
  // Disable response buffering
  res.flushHeaders();
  
  // Keep the connection alive with more frequent pings in production
  const keepAliveInterval = process.env.NODE_ENV === 'production' ? 15000 : 30000;
  const keepAlive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
      console.log(`Sent keepalive to: ${req.ip} at ${new Date().toISOString()}`);
    } catch (error) {
      console.error('Error sending keepalive:', error);
      clearInterval(keepAlive);
      sseManager.removeClient(clientId);
    }
  }, keepAliveInterval);

  // Add client to SSE manager
  const clientId = sseManager.addClient(res);
  console.log('Added SSE client:', clientId, 'Environment:', process.env.NODE_ENV);

  // Clean up on connection close
  res.on('close', () => {
    console.log('SSE connection closed for client:', clientId);
    clearInterval(keepAlive);
    sseManager.removeClient(clientId);
  });
});

export default router; 