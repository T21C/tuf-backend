import dotenv from 'dotenv';

dotenv.config();

export const clientUrlEnv =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_CLIENT_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_CLIENT_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.CLIENT_URL
        : 'http://localhost:5173';

export const port =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_PORT
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_PORT
      : process.env.NODE_ENV === 'development'
        ? process.env.PORT
        : '3002';

export const ownUrl =
  process.env.NODE_ENV === 'production'
    ? process.env.PROD_API_URL
    : process.env.NODE_ENV === 'staging'
      ? process.env.STAGING_API_URL
      : process.env.NODE_ENV === 'development'
        ? process.env.DEV_URL
        : 'http://localhost:3002';

export const corsOptions = {
  origin: [
    clientUrlEnv || 'http://localhost:5173',
    'https://localhost:5173',
    'https://tuforums.com',
    'https://api.tuforums.com',
    'https://4p437dcj-5173.eun1.devtunnels.ms',
    'https://4p437dcj-3002.eun1.devtunnels.ms',
  ],
  methods: [
    'GET',
    'POST',
    'PUT',
    'DELETE',
    'OPTIONS',
    'PATCH',
    'HEAD',
    'CONNECT',
    'TRACE',
  ],
  credentials: true,
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Cache-Control',
    'Last-Event-ID',
    'X-Form-Type',
    'X-Super-Admin-Password',
    'X-File-Id',
    'X-Chunk-Index',
    'X-Total-Chunks',
    'If-None-Match',
    'If-Modified-Since'
  ],
  exposedHeaders: [
    'Content-Type',
    'Authorization',
    'Cache-Control',
    'Last-Event-ID',
    'X-Form-Type',
    'X-Super-Admin-Password',
    'X-File-Id',
    'X-Chunk-Index',
    'X-Total-Chunks',
    'ETag',
    'Last-Modified'
  ],
}; 