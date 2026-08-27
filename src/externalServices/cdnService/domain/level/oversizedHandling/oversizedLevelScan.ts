import fs from 'fs';
import type {PathLike} from 'fs';
import {fileURLToPath} from 'url';
import {logger} from '@/server/services/core/LoggerService.js';
import {
  Json5LevelScanner,
  type OversizedLevelBasics,
} from './json5LevelScan.js';

export type {OversizedLevelBasics} from './json5LevelScan.js';
export {scanJson5LevelText, SETTINGS_KEYS_OF_INTEREST} from './json5LevelScan.js';

function pathLikeForLog(p: PathLike): string {
  if (Buffer.isBuffer(p)) return `Buffer(${p.length} bytes)`;
  if (typeof p === 'string') return p;
  try {
    return fileURLToPath(p);
  } catch {
    return String(p);
  }
}

/**
 * Stream-scan a huge .adofai JSON5 document without loading it into V8 heap.
 *
 * Extracts:
 *  - `tilecount`: number of finite items in `angleData` (or `pathData` length).
 *  - `settings`: `bpm`, `offset`, `songFilename`, `song`, `artist`, `author`.
 *
 * JSON5 (comments, trailing commas, single quotes, unquoted keys, control chars in
 * strings). Stops as soon as `angleData`/`pathData` and `settings` are both read so
 * later actions/decorations — including illegal JSON — are not parsed.
 */
export async function scanOversizedLevelFile(localAdoPath: PathLike): Promise<OversizedLevelBasics> {
  const scanner = new Json5LevelScanner();
  const stream = fs.createReadStream(localAdoPath, {
    encoding: 'utf8',
    highWaterMark: 64 * 1024,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      stream.on('data', (chunk: string | Buffer) => {
        if (settled) return;
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        scanner.feed(text, false);
        if (scanner.done) {
          settled = true;
          stream.destroy();
          resolve();
        }
      });

      stream.on('end', () => {
        if (settled) return;
        scanner.feed('', true);
        finish();
      });

      stream.on('error', err => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  } catch (err) {
    logger.warn('scanOversizedLevelFile: JSON5 scan failed', {
      localAdoPath: pathLikeForLog(localAdoPath),
      error: err instanceof Error ? err.message : String(err),
    });
    return scanner.tilecount || Object.keys(scanner.settings).length
      ? scanner.result()
      : {tilecount: 0, settings: {}};
  }

  return scanner.result();
}
