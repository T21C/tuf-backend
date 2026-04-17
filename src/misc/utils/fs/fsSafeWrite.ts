import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

/**
 * Atomic write: write to a sibling `.tmp.<random>` file, fsync, then rename over the target.
 * Same-volume rename is atomic on POSIX and Windows (NTFS), so concurrent readers either see
 * the previous full file or the new full file — never a half-written one.
 */
export async function writeFileAtomic(
  absPath: string,
  data: Buffer | string,
): Promise<void> {
  const dir = path.dirname(absPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `${path.basename(absPath)}.tmp.${crypto.randomBytes(6).toString('hex')}`,
  );
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(tmpPath, 'w');
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tmpPath, absPath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Atomic stream write: pipes `source` into a sibling `.tmp.<random>` file, fsyncs, then
 * renames over the target. Same atomicity guarantee as {@link writeFileAtomic}.
 * Honors `signal` for early abort (partial tmp file is removed).
 */
export async function writeStreamAtomic(
  absPath: string,
  source: Readable,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const dir = path.dirname(absPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `${path.basename(absPath)}.tmp.${crypto.randomBytes(6).toString('hex')}`,
  );
  const writeStream = fs.createWriteStream(tmpPath);
  try {
    await pipeline(source, writeStream, { signal: options?.signal });
    const fd = await fs.promises.open(tmpPath, 'r+');
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
    await fs.promises.rename(tmpPath, absPath);
  } catch (error) {
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}
