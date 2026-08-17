import fs from 'node:fs/promises';
import path from 'node:path';
import {THUMBNAIL_WORKER_CONFIG} from './config.js';

const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function assertSafeFileName(fileName: string, extension: '.html' | '.png'): void {
  if (!SAFE_FILE_NAME.test(fileName) || path.extname(fileName) !== extension) {
    throw new Error(`Unsafe thumbnail worker file name: ${fileName}`);
  }
}

export function inputPath(fileName: string): string {
  assertSafeFileName(fileName, '.html');
  return path.join(THUMBNAIL_WORKER_CONFIG.inputDirectory, fileName);
}

export function outputPath(fileName: string): string {
  assertSafeFileName(fileName, '.png');
  return path.join(THUMBNAIL_WORKER_CONFIG.outputDirectory, fileName);
}

export async function ensureThumbnailWorkerDirectories(): Promise<void> {
  await Promise.all([
    fs.mkdir(THUMBNAIL_WORKER_CONFIG.inputDirectory, {recursive: true}),
    fs.mkdir(THUMBNAIL_WORKER_CONFIG.outputDirectory, {recursive: true}),
  ]);
}

export async function writeHtmlInputAtomically(fileName: string, html: string): Promise<void> {
  const destination = inputPath(fileName);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const htmlBytes = Buffer.byteLength(html, 'utf8');
  if (htmlBytes > THUMBNAIL_WORKER_CONFIG.maxHtmlBytes) {
    throw new Error(
      `Thumbnail input exceeds ${THUMBNAIL_WORKER_CONFIG.maxHtmlBytes} bytes: ${fileName}`,
    );
  }

  try {
    await fs.writeFile(temporary, html, {encoding: 'utf8', mode: 0o600});
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, {force: true});
  }
}

export async function readHtmlInput(fileName: string): Promise<string> {
  const source = inputPath(fileName);
  const stat = await fs.lstat(source);
  if (!stat.isFile()) throw new Error(`Thumbnail input is not a file: ${fileName}`);
  if (stat.size > THUMBNAIL_WORKER_CONFIG.maxHtmlBytes) {
    throw new Error(
      `Thumbnail input exceeds ${THUMBNAIL_WORKER_CONFIG.maxHtmlBytes} bytes: ${fileName}`,
    );
  }
  return fs.readFile(source, 'utf8');
}

export async function writePngOutputAtomically(fileName: string, png: Buffer): Promise<void> {
  const destination = outputPath(fileName);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, png, {mode: 0o640});
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, {force: true});
  }
}

export async function removeHtmlInput(fileName: string): Promise<void> {
  await fs.rm(inputPath(fileName), {force: true});
}
