import fs from 'fs';
import type { PathLike } from 'fs';
import { fileURLToPath } from 'url';
import { chain } from 'stream-chain';
import { parser } from 'stream-json/parser.js';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import { streamObject } from 'stream-json/streamers/stream-object.js';
import { pick } from 'stream-json/filters/pick.js';
import { logger } from '@/server/services/core/LoggerService.js';

function pathLikeForLog(p: PathLike): string {
    if (Buffer.isBuffer(p)) return `Buffer(${p.length} bytes)`;
    if (typeof p === 'string') return p;
    try {
        return fileURLToPath(p);
    } catch {
        return String(p);
    }
}

export type OversizedLevelBasics = {
  tilecount: number;
  settings: {
    bpm?: unknown;
    offset?: unknown;
    songFilename?: unknown;
    /** Title field. Read for ZIP-filename encoding detection (used as a fallback reference string). */
    song?: unknown;
    /** Artist field. Read for ZIP-filename encoding detection. */
    artist?: unknown;
    /** Author field. Read for ZIP-filename encoding detection. */
    author?: unknown;
  };
};

/** Settings keys we extract for both the oversized-cache path and ZIP-filename encoding detection. */
const SETTINGS_KEYS_OF_INTEREST = ['bpm', 'offset', 'songFilename', 'song', 'artist', 'author'] as const;
type SettingsKey = typeof SETTINGS_KEYS_OF_INTEREST[number];

/** Rolling-window size for the regex fallback (32 KiB is comfortably larger than any realistic field value). */
const REGEX_FALLBACK_TAIL_BYTES = 32 * 1024;
/** Hard cap on how far the regex fallback will read before giving up. Settings usually appear within ~10 MiB even on huge charts. */
const REGEX_FALLBACK_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Stream-scan a huge .adofai JSON without loading it into V8 heap.
 *
 * Extracts:
 *  - `tilecount`: number of items in `angleData` (best-effort — 0 on regex fallback).
 *  - `settings`: `bpm`, `offset`, `songFilename`, `song`, `artist`, `author`.
 *
 * Tries the strict `stream-json` pipeline first (fast, low memory, exact JSON semantics). If
 * that throws (commonly: missing commas, trailing commas, single quotes — `.adofai` files in
 * the wild are not always strict JSON), falls back to a bounded-memory **rolling-window regex
 * scan** that pulls the same field-name/value pairs out of the raw text. The fallback does
 * not count `angleData` items — callers that depend on `tilecount` should treat `0` as
 * "unknown" (existing `tooLargeToParse` / file-size caps in the ingest path already handle
 * the safety side of that).
 */
export async function scanOversizedLevelFile(localAdoPath: PathLike): Promise<OversizedLevelBasics> {
  try {
    return await scanViaStreamJson(localAdoPath);
  } catch (err) {
    logger.debug('scanOversizedLevelFile: stream-json failed; falling back to regex scan', {
      localAdoPath: pathLikeForLog(localAdoPath),
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      return await scanViaRegexFallback(localAdoPath);
    } catch (fallbackErr) {
      logger.warn('scanOversizedLevelFile: regex fallback also failed', {
        localAdoPath: pathLikeForLog(localAdoPath),
        error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
      });
      return { tilecount: 0, settings: {} };
    }
  }
}

/** Strict-JSON streaming pipeline (the original implementation, with the additional settings keys). */
async function scanViaStreamJson(localAdoPath: PathLike): Promise<OversizedLevelBasics> {
  const settings: OversizedLevelBasics['settings'] = {};
  let tilecount = 0;

  // angleData: count items.
  const anglePipeline = chain([
    fs.createReadStream(localAdoPath, { encoding: 'utf8' }),
    parser(),
    pick({ filter: 'angleData' }),
    streamArray(),
  ]);

  for await (const chunk of anglePipeline) {
    if (typeof chunk?.value === 'number' && Number.isFinite(chunk.value)) {
      tilecount++;
    }
  }

  // settings: read the keys we care about.
  const settingsPipeline = chain([
    fs.createReadStream(localAdoPath, { encoding: 'utf8' }),
    parser(),
    pick({ filter: 'settings' }),
    streamObject(),
  ]);

  for await (const chunk of settingsPipeline) {
    const key = chunk?.key;
    if (typeof key !== 'string') continue;
    if ((SETTINGS_KEYS_OF_INTEREST as readonly string[]).includes(key)) {
      (settings as Record<SettingsKey, unknown>)[key as SettingsKey] = chunk.value;
    }
    if (SETTINGS_KEYS_OF_INTEREST.every((k) => settings[k] !== undefined)) {
      break;
    }
  }

  return { tilecount, settings };
}

/**
 * Regex-based fallback that tolerates JSON variants `stream-json` rejects (missing commas,
 * trailing commas, single quotes, comments, …). We don't pretend to parse JSON correctly —
 * we just walk a bounded rolling window of the file text and pull out the FIRST top-level
 * occurrence of each `"key": "value"` we care about.
 *
 * Bounded memory: `REGEX_FALLBACK_TAIL_BYTES` rolling tail regardless of file size. Bounded
 * time: stops after `REGEX_FALLBACK_MAX_BYTES` or once every wanted key has been captured.
 *
 * Limitations:
 *  - Doesn't count `angleData` items → `tilecount: 0`. Acceptable: the only consumer in the
 *    ingest path uses this as one of several "treat-as-oversized" signals alongside the
 *    cheaper file-size cap (`MAX_LEVEL_FILE_SIZE_FOR_PARSE`).
 *  - First textual occurrence wins; a nested `"song"` inside e.g. an event payload theoretically
 *    overrides `settings.song`. In practice the modern .adofai layout writes `settings` before
 *    `actions` / `decorations`, and none of the deep payloads use the same key names.
 */
async function scanViaRegexFallback(localAdoPath: PathLike): Promise<OversizedLevelBasics> {
  return new Promise<OversizedLevelBasics>((resolve, reject) => {
    const settings: OversizedLevelBasics['settings'] = {};
    let tail = '';
    let bytesRead = 0;
    let settled = false;

    const stream = fs.createReadStream(localAdoPath, {
      encoding: 'utf8',
      highWaterMark: 64 * 1024,
    });

    const finish = () => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve({ tilecount: 0, settings });
    };

    const tryExtractStrings = () => {
      // String fields go through JSON.parse so \u escapes / \" / \\ decode correctly.
      for (const key of ['songFilename', 'song', 'artist', 'author'] as const) {
        if (settings[key] !== undefined) continue;
        const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
        const m = re.exec(tail);
        if (m) {
          try {
            const parsed = JSON.parse(`"${m[1]}"`);
            if (typeof parsed === 'string') settings[key] = parsed;
          } catch {
            /* leave undefined and retry on later chunks */
          }
        }
      }
      // Numeric fields: accept integers or decimals; tolerate trailing comma / brace.
      for (const key of ['bpm', 'offset'] as const) {
        if (settings[key] !== undefined) continue;
        const re = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`);
        const m = re.exec(tail);
        if (m) {
          const n = Number(m[1]);
          if (Number.isFinite(n)) settings[key] = n;
        }
      }
    };

    const allFound = () => SETTINGS_KEYS_OF_INTEREST.every((k) => settings[k] !== undefined);

    stream.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      bytesRead += Buffer.byteLength(text, 'utf8');
      tail = tail + text;

      tryExtractStrings();

      if (allFound() || bytesRead >= REGEX_FALLBACK_MAX_BYTES) {
        finish();
        return;
      }
      if (tail.length > REGEX_FALLBACK_TAIL_BYTES) {
        tail = tail.slice(-REGEX_FALLBACK_TAIL_BYTES);
      }
    });

    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}
