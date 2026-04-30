import fs from 'fs';
import { chain } from 'stream-chain';
import { parser } from 'stream-json/parser.js';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import { streamObject } from 'stream-json/streamers/stream-object.js';
import { pick } from 'stream-json/filters/pick.js';

export type OversizedLevelBasics = {
  tilecount: number;
  settings: {
    bpm?: unknown;
    offset?: unknown;
    songFilename?: unknown;
  };
};

/**
 * Stream-scan a huge .adofai JSON without loading it into V8 heap.
 * Extracts:
 * - tilecount: angleData array length
 * - settings: bpm/offset/songFilename (unknown typed, caller can normalize)
 */
export async function scanOversizedLevelFile(localAdoPath: string): Promise<OversizedLevelBasics> {
  const settings: OversizedLevelBasics['settings'] = {};
  let tilecount = 0;

  // angleData: count items
  const anglePipeline = chain([
    fs.createReadStream(localAdoPath, { encoding: 'utf8' }),
    parser(),
    pick({ filter: 'angleData' }),
    streamArray()
  ]);

  for await (const chunk of anglePipeline) {
    // streamArray yields {key, value}; keys are array indices (as numbers).
    if (typeof chunk?.value === 'number' && Number.isFinite(chunk.value)) {
      tilecount++;
    }
  }

  // settings: read bpm/offset/songFilename. We pick the whole `settings` object but only keep 3 keys.
  const settingsPipeline = chain([
    fs.createReadStream(localAdoPath, { encoding: 'utf8' }),
    parser(),
    pick({ filter: 'settings' }),
    streamObject()
  ]);

  // With pick('settings'), streamObject emits key/value pairs of the settings object.
  for await (const chunk of settingsPipeline) {
    const key = chunk?.key;
    if (key === 'bpm') {
      settings.bpm = chunk.value;
    } else if (key === 'offset') {
      settings.offset = chunk.value;
    } else if (key === 'songFilename') {
      settings.songFilename = chunk.value;
    }

    if (
      settings.bpm !== undefined &&
      settings.offset !== undefined &&
      settings.songFilename !== undefined
    ) {
      break;
    }
  }

  return { tilecount, settings };
}

