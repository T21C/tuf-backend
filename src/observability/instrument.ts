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
  process.env.SENTRY_SERVER_NAME = entry.includes('cdnService') ? 'cdn' : 'api';
}

initSentry();
registerErrorLogCapture();
