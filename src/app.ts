import express, {Express, Request, Response, NextFunction} from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import {createServer} from 'http';
import {Server} from 'socket.io';
import db from '@/models/index.js';
import {setIO} from '@/misc/utils/server/socket.js';
import {htmlMetaMiddleware} from '@/server/middleware/html-meta.js';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import routes from '@/server/routes/index.js';
import { generateOpenApiFromApp } from '@/server/middleware/apiDocCollector.js';
import queryValidator from '@/server/middleware/queryValidator.js';
import {fileURLToPath} from 'url';
import { logger } from './server/services/LoggerService.js';
import { clientUrlEnv, port, corsOptions } from './config/app.config.js';
import { initializeDefaultPools } from './config/poolConfig.js';
import { registerGlobalProcessHandlers } from '@/server/bootstrap/processHandlers.js';
import { initializeRuntimeServices, shutdownRuntimeServices } from '@/server/bootstrap/runtimeServices.js';
import { slowEndpointLoggingMiddleware } from '@/server/middleware/slowEndpointLogging.js';
// CRITICAL: Initialize pools BEFORE importing models to ensure logging database is available
initializeDefaultPools();

dotenv.config();
registerGlobalProcessHandlers({ onShutdown: shutdownRuntimeServices });

const app: Express = express();
const httpServer = createServer(app);

// Trust proxy headers for proper IP address handling
app.set('trust proxy', true);

// ES Module dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create Socket.IO instance
const io = new Server(httpServer, {
  cors: {
    origin: [
      clientUrlEnv || 'http://localhost:5173',
      'https://tuforums.com',
      'https://api.tuforums.com',
    ],
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

setIO(io);

// Socket connection handler
io.on('connection', socket => {
  socket.on('disconnect', reason => {
    logger.debug('Socket disconnected:', reason);
  });
});

// Initialize database and start server
export async function startServer() {
  try {
    // First, verify database connection
    await db.sequelize.authenticate();

    if (process.env.INIT_DB === 'true'){
      logger.info('Initializing database...');
      await db.sequelize.sync({force: true});
    }

    logger.info('Database connection established.');

    // Start non-Express runtime services (Redis, search, scheduled jobs).
    await initializeRuntimeServices();

    // Enable pre-flight requests for all routes
    app.options('*', cors(corsOptions));

    // Apply CORS middleware to all routes
    app.use(cors(corsOptions));

    app.use(express.json());
    app.use(express.urlencoded({extended: true}));
    app.use(cookieParser());
    app.use(queryValidator);

    app.use(slowEndpointLoggingMiddleware);

    // Set up API routes first
    app.use('/', routes);

    // Build OpenAPI from ApiDoc() routes and expose at {baseurl}/docs and {baseurl}/openapi.json
    try {
      const openApiSpec = await generateOpenApiFromApp(app, {
        title: 'TUF API',
        version: '2.0.0',
        description: 'API documentation for The Universal Forums (TUF)',
      });
      (app as Express & { locals: { openApiSpec?: Record<string, unknown> } }).locals.openApiSpec = openApiSpec;

      app.get('/openapi.json', (_req: Request, res: Response) => {
        const spec = (app as Express & { locals: { openApiSpec?: Record<string, unknown> } }).locals.openApiSpec;
        if (!spec) return res.status(503).json({ error: 'OpenAPI spec not built' });
        res.setHeader('Content-Type', 'application/json');
        return res.json(spec);
      });
      app.use(
        '/docs',
        swaggerUi.serve,
        swaggerUi.setup(undefined, {
          swaggerOptions: { url: '/openapi.json', persistAuthorization: true },
        })
      );
      logger.debug('OpenAPI spec built; /docs and /openapi.json available');
    } catch (err) {
      logger.warn('OpenAPI spec build from routes failed (non-fatal):', err);
    }

    // HTML meta tags middleware for specific routes BEFORE static files
    app.get(['/passes/:id', '/levels/:id', '/profile/:id', '/packs/:id'], htmlMetaMiddleware);

    // Handle static files and SPA routing
    const clientBuildPath =
      process.env.NODE_ENV === 'production'
        ? path.join(__dirname, '../../client/dist')
        : path.join(__dirname, '../../client/dist');

    // Serve static assets (but not index.html)
    app.use(
      express.static(clientBuildPath, {
        index: false,
        // Only serve files from the assets directory
        setHeaders: (res, filePath) => {
          if (filePath.includes('/assets/')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000');
          }
        },
      }),
    );

    // Handle remaining HTML requests
    app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'index.html'));
    });
    app.get('*', (req, res) => {
      return res.status(404).sendFile(path.join(__dirname, 'notFound.html'));
    });

    // Global error handling middleware - must be last
// eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: any, req: Request, res: Response, next: NextFunction) => {
      // Handle connection reset errors gracefully
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
        // Client disconnected - don't send response if headers already sent
        if (!res.headersSent) {
          return res.status(499).json({
            error: 'Client disconnected'
          });
        }
        // Headers already sent, just log and return
        logger.debug('Client disconnected during response:', {
          code: err.code,
          path: req.path,
          method: req.method
        });
        return;
      }

      // Handle URI decoding errors specifically
      if (err instanceof URIError) {
        logger.debug('URI decoding error:', {
          error: err.message,
          path: req.path,
          method: req.method,
          ip: req.connection.remoteAddress || req.ip
        });

        return res.status(400).json({
          error: 'Invalid URL encoding',
          message: 'The requested URL contains invalid characters'
        });
      }

      // Handle other Express errors
      if (!err.skipLogging) {
        logger.error('Express error:', {
          error: err.message || err.error,
          code: err.code,
          stack: err.stack,
          path: req.path,
          method: req.method,
          ip: req.ip
        });
      }

      // Only send error response if headers haven't been sent
      if (!res.headersSent) {
        return res.status(500).json({
          error: 'Internal server error',
          message: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
      }
      return
    });

    // Start the server
    const bindAddress = process.env.BIND_ADDRESS || '127.0.0.1';
    await new Promise<void>(resolve => {
      httpServer.listen(Number(port), bindAddress, () => {
        logger.info(
          `Server running on ${bindAddress}:${port} (${process.env.NODE_ENV} environment)`,
        );
        resolve();
      });
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    throw error;
  }
}

// Start the server
startServer().catch(error => {
  logger.error('Failed to start server:', error);
  throw error;
});

export default app;
