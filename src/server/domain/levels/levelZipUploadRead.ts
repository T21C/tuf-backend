import fs from 'fs';

/** True when a read/access failed because the path is missing (orphaned session vs disk). */
export function isAssembledZipMissingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || /\bENOENT\b/.test(err.message);
}

/**
 * Read the chunked-upload assembled zip with short retries (FS settle).
 * Callers doing async finalize should snapshot the buffer before returning 202 so CDN work
 * does not depend on the session workspace still being on disk (reaper/cancel/races).
 */
export async function readAssembledLevelZipFromPath(assembledFilePath: string): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 5; attempt > 0; attempt--) {
    try {
      await fs.promises.access(assembledFilePath);
      return await fs.promises.readFile(assembledFilePath);
    } catch (e) {
      lastErr = e;
      if (attempt <= 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const hint = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `${hint} (assembled zip not readable at ${assembledFilePath}: incomplete upload, expired/reaped session, client cancelled the session, or a rare race with cleanup)`,
  );
}
