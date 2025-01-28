import { Router } from 'express';
import { sseManager } from '../utils/sse';

const router: Router = Router();

// SSE endpoint
router.get('/', (req, res) => {
  console.log('New SSE connection request from:', req.ip);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Environment:', process.env.NODE_ENV);
  console.log('Origin:', req.headers.origin);

  try {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    
    // Set CORS headers explicitly
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || 'https://tuforums.com');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // Log headers being sent
    console.log('Response headers:', res.getHeaders());
    
    // Disable response buffering
    res.flushHeaders();
    
    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    
    // Keep the connection alive
    const keepAlive = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
        console.log(`Sent keepalive to: ${req.ip} at ${new Date().toISOString()}`);
      } catch (error) {
        console.error('Error sending keepalive:', error);
        clearInterval(keepAlive);
      }
    }, 15000);

    // Add client to SSE manager
    const clientId = sseManager.addClient(res);
    console.log('Added SSE client:', clientId);

    // Clean up on connection close
    res.on('close', () => {
      console.log('SSE connection closed for client:', clientId);
      clearInterval(keepAlive);
      sseManager.removeClient(clientId);
    });
  } catch (error) {
    console.error('Error setting up SSE connection:', error);
    res.status(500).end();
  }
});

export default router; 