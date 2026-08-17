import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {THUMBNAIL_WORKER_CONFIG} from './config.js';
import {outputPath} from './fileStore.js';
import {enqueueThumbnailRender} from './producer.js';
import {closeThumbnailQueueClients} from './queue.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SMOKE_TIMEOUT_MS = 60_000;

async function waitForPng(fileName: string): Promise<Buffer> {
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(outputPath(fileName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, THUMBNAIL_WORKER_CONFIG.outputPollMs));
  }
  throw new Error(`Thumbnail worker smoke render timed out after ${SMOKE_TIMEOUT_MS}ms`);
}

async function main(): Promise<void> {
  const smokeId = randomUUID();
  const outputFileName = `worker_smoke_${smokeId}.png`;

  try {
    await enqueueThumbnailRender({
      entityType: 'wheel',
      entityId: `smoke-${smokeId}`,
      outputFileName,
      width: 64,
      height: 64,
      html: '<!doctype html><html><body style="margin:0;background:#6545e8;width:64px;height:64px"></body></html>',
    });

    const png = await waitForPng(outputFileName);
    if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error('Thumbnail worker smoke output is not a PNG');
    }

    console.log(`thumbnail worker smoke passed (${png.length} bytes)`);
    await fs.rm(outputPath(outputFileName), {force: true});
  } finally {
    await closeThumbnailQueueClients();
  }
}

await main();
