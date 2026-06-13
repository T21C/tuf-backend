import fs from 'fs';
import zlib from 'zlib';

/** Minimal valid `.adofai` JSON for pentest fixtures (parsable by ingest). */
export const MINIMAL_ADOFAI_JSON = JSON.stringify(
  {
    angleData: [0, 0, 0],
    settings: {
      bpm: 100,
      offset: 0,
      artist: 'pentest',
      song: 'pentest',
      author: 'pentest',
      songFilename: 'song.ogg',
    },
  },
  null,
  2,
);

export interface ZipFixtureEntry {
  /** Archive-internal path (may include `../` for zip-slip tests). */
  path: string;
  data: Buffer;
  /**
   * When set, central-directory + local headers advertise this uncompressed size
   * while `data` stays small (zip-bomb metadata attack).
   */
  declaredUncompressedSize?: number;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const METHOD_DEFLATE = 8;
const METHOD_STORE = 0;

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimeDate(): { time: number; date: number } {
  const d = new Date();
  const time =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    Math.floor(d.getSeconds() / 2);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    (d.getDate() & 0x1f);
  return { time, date };
}

interface BuiltEntry {
  path: string;
  localOffset: number;
  compressed: Buffer;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
}

/**
 * Build a ZIP from entries. Supports inflated `declaredUncompressedSize` for bomb tests.
 * Uses raw DEFLATE (method 8, no zlib wrapper) to match ZIP spec.
 */
export function buildZip(entries: ZipFixtureEntry[]): Buffer {
  const { time, date } = dosTimeDate();
  const parts: Buffer[] = [];
  const built: BuiltEntry[] = [];

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.path.replace(/\\/g, '/'), 'utf8');
    const localOffset = Buffer.concat(parts).length;

    let method = METHOD_DEFLATE;
    let compressed: Buffer;
    let uncompressedSize = entry.data.length;
    let crc = crc32(entry.data);

    if (entry.declaredUncompressedSize != null) {
      uncompressedSize = entry.declaredUncompressedSize;
      compressed = zlib.deflateRawSync(entry.data);
      method = METHOD_DEFLATE;
    } else if (entry.data.length > 0) {
      compressed = zlib.deflateRawSync(entry.data);
    } else {
      compressed = Buffer.alloc(0);
      method = METHOD_STORE;
    }

    const compressedSize = compressed.length;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    parts.push(local, compressed);
    built.push({
      path: entry.path,
      localOffset,
      compressed,
      crc,
      compressedSize,
      uncompressedSize,
      method,
    });
  }

  const centralStart = Buffer.concat(parts).length;
  for (const e of built) {
    const nameBuf = Buffer.from(e.path.replace(/\\/g, '/'), 'utf8');
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(e.method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.compressedSize, 20);
    central.writeUInt32LE(e.uncompressedSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(e.localOffset, 42);
    nameBuf.copy(central, 46);
    parts.push(central);
  }

  const centralSize = Buffer.concat(parts).length - centralStart;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(built.length, 8);
  end.writeUInt16LE(built.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  parts.push(end);

  return Buffer.concat(parts);
}

/**
 * Write a single STORED entry ZIP without holding the full payload in memory.
 * Used for the 12 GiB+ size-cap fixture.
 */
export async function buildStoredZipFile(
  outPath: string,
  entryPath: string,
  payloadBytes: number,
): Promise<void> {
  const { time, date } = dosTimeDate();
  const nameBuf = Buffer.from(entryPath.replace(/\\/g, '/'), 'utf8');
  const crc = 0; // zeros
  const method = METHOD_STORE;
  const compressedSize = payloadBytes;
  const uncompressedSize = payloadBytes;

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(LOCAL_SIG, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressedSize, 18);
  local.writeUInt32LE(uncompressedSize, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);

  const fh = await fs.promises.open(outPath, 'w');
  try {
    await fh.write(local);
    const chunk = 4 * 1024 * 1024;
    const zero = Buffer.alloc(chunk, 0);
    let remaining = payloadBytes;
    while (remaining > 0) {
      const n = Math.min(chunk, remaining);
      await fh.write(n === chunk ? zero : zero.subarray(0, n));
      remaining -= n;
    }

    const localOffset = 0;
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    nameBuf.copy(central, 46);
    await fh.write(central);

    const centralSize = central.length;
    const centralStart = local.length + payloadBytes;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_SIG, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralStart, 16);
    end.writeUInt16LE(0, 20);
    await fh.write(end);
  } finally {
    await fh.close();
  }
}

/** ~64 KiB of nulls — compresses tiny, can advertise huge uncompressed size. */
export function nullPayload(bytes = 64 * 1024): Buffer {
  return Buffer.alloc(bytes, 0);
}
