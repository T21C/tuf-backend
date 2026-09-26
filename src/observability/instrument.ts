/**
 * Side-effect entry for Sentry. Import this FIRST in api/cdn entrypoints.
 */
import dotenv from 'dotenv';
import { initSentry } from './sentryInit.js';
import { registerErrorLogCapture } from './registerErrorLogCapture.js';

// Ensure env is available even when this module is the first import.
dotenv.config();

if (!process.env.SENTRY_SERVER_NAME?.trim()) {
  const entry = process.argv[1] || '';
  if (entry.includes('cdnService')) process.env.SENTRY_SERVER_NAME = 'cdn';
  else if (entry.includes('bilibiliProxy')) process.env.SENTRY_SERVER_NAME = 'bilibili-proxy';
  else process.env.SENTRY_SERVER_NAME = 'api';
}

initSentry();
registerErrorLogCapture();
