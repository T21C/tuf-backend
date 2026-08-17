import fs from 'node:fs/promises';
import path from 'node:path';
import type {Request, Response} from 'express';
import type {ThumbnailEntityType} from './contracts.js';
import {THUMBNAIL_WORKER_CONFIG} from './config.js';
import {enqueueThumbnailRender, ThumbnailQueueUnavailableError} from './producer.js';
import {outputPath} from './fileStore.js';

export class ThumbnailRenderPendingError extends Error {
  constructor(readonly waitMs: number) {
    super(`Thumbnail render is still processing after ${waitMs}ms`);
    this.name = 'ThumbnailRenderPendingError';
  }
}

interface RenderHtmlOptions {
  entityType: ThumbnailEntityType;
  entityId: string | number;
  html: string;
  outputFileName: string;
  width: number;
  height: number;
  waitMs: number;
  localRender: () => Promise<Buffer>;
}

async function readOutputIfPresent(fileName: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(outputPath(fileName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function waitForOutput(fileName: string, waitMs: number): Promise<Buffer | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const output = await readOutputIfPresent(fileName);
    if (output) return output;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(
      resolve,
      Math.min(THUMBNAIL_WORKER_CONFIG.outputPollMs, remaining),
    ));
  }
  return readOutputIfPresent(fileName);
}

export function resolveThumbnailWaitMs(wait: unknown): number {
  return wait === 'og'
    ? THUMBNAIL_WORKER_CONFIG.ogRequestWaitMs
    : THUMBNAIL_WORKER_CONFIG.requestWaitMs;
}

export function thumbnailWaitMs(req: Request): number {
  return resolveThumbnailWaitMs(req.query.wait);
}

export function thumbnailGenerationKey(base: string, req: Request): string {
  if (THUMBNAIL_WORKER_CONFIG.renderMode === 'local') return base;
  return `${base}-queue-${thumbnailWaitMs(req)}`;
}

export async function renderHtmlToPng(options: RenderHtmlOptions): Promise<Buffer> {
  if (THUMBNAIL_WORKER_CONFIG.renderMode === 'local') {
    return options.localRender();
  }

  const existing = await readOutputIfPresent(options.outputFileName);
  if (existing) return existing;

  await enqueueThumbnailRender({
    entityType: options.entityType,
    entityId: options.entityId,
    html: options.html,
    outputFileName: options.outputFileName,
    width: options.width,
    height: options.height,
  });

  const output = await waitForOutput(options.outputFileName, options.waitMs);
  if (output) return output;
  throw new ThumbnailRenderPendingError(options.waitMs);
}

export function sendThumbnailRenderError(res: Response, error: unknown): boolean {
  if (error instanceof ThumbnailRenderPendingError) {
    res.status(204).set({
      'Retry-After': '2',
      'Cache-Control': 'no-store',
      'X-Thumbnail-Status': 'processing',
    }).end();
    return true;
  }
  if (error instanceof ThumbnailQueueUnavailableError) {
    res.status(503).set({'Retry-After': '2'}).json({
      error: 'Thumbnail renderer unavailable',
    });
    return true;
  }
  return false;
}

export function outputFileNameFromPath(filePath: string): string {
  return path.basename(filePath);
}
