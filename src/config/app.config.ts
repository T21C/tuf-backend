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
    'http://localhost:5173',
    'https://tuforums.com',
    'https://api.tuforums.com',
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
    'Pragma',
    'Expires',
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
    'Pragma',
    'Expires',
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
