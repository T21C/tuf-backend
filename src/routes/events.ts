import { Router } from 'express';
import { sseManager } from '../utils/sse';
import { Auth } from '../middleware/auth';
import cors from 'cors';

const router: Router = Router();

const clientUrl = process.env.NODE_ENV === 'production' 
? process.env.PROD_CLIENT_URL 
: process.env.NODE_ENV === 'staging'
? process.env.STAGING_CLIENT_URL
: process.env.NODE_ENV === 'development'
? process.env.CLIENT_URL 
: 'http://localhost:5173';

// Configure CORS for SSE
const corsOptions = {
  origin: clientUrl,
  credentials: true,
  methods: ['GET'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Range', 'Content-Type', 'Authorization'],
};

console.log("SSE corsOptions", corsOptions);

// SSE endpoint
router.get('/', cors(corsOptions), (req, res) => {
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