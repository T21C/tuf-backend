import { parseFile } from 'music-metadata';

/**
 * Read raw audio duration (ms) from a local file.
 * Uses header-based parsing; does not load the entire file into memory.
 */
export async function readAudioDurationMs(localAudioPath: string): Promise<number | null> {
  try {
    const meta = await parseFile(localAudioPath, { duration: true });
    const seconds = meta.format.duration;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
      return null;
    }
    return Math.round(seconds * 1000);
  } catch {
    return null;
  }
}

