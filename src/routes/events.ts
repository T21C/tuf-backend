import { Router } from 'express';
import { Auth } from '../middleware/auth';
import { sseManager } from '../utils/sse';
import cors from 'cors';

const router: Router = Router();

// Handle preflight requests
router.options('/', cors());

router.get('/', cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Last-Event-ID'],
  exposedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Last-Event-ID']
}), (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering
  res.setHeader('Access-Control-Allow-Origin', process.env.CLIENT_URL || 'http://localhost:5173');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.flushHeaders();

  // Add this client to the SSE manager
  const clientId = sseManager.addClient(res);

  // Send an initial ping to establish the connection
  res.write(`data: {"type":"ping","clientId":"${clientId}"}\n\n`);

  // Keep the connection alive with a ping every 30 seconds
  const pingInterval = setInterval(() => {
    try {
      if (res.writableEnded) {
        clearInterval(pingInterval);
        sseManager.removeClient(clientId);
        return;
      }
      res.write(`data: {"type":"ping","clientId":"${clientId}"}\n\n`);
    } catch (error) {
      console.error('Error sending ping:', error);
      clearInterval(pingInterval);
      sseManager.removeClient(clientId);
    }
  }, 30000);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(pingInterval);
    sseManager.removeClient(clientId);
  });

  // Handle errors
  req.on('error', (error) => {
    console.error('SSE connection error:', error);
    clearInterval(pingInterval);
    sseManager.removeClient(clientId);
  });

  // Handle response errors
  res.on('error', (error) => {
    console.error('SSE response error:', error);
    clearInterval(pingInterval);
    sseManager.removeClient(clientId);
  });
});

export default router; 