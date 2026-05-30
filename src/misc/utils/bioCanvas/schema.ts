import { z } from 'zod';
import { getBlockDescriptor, BLOCK_DESCRIPTORS, type BlockType } from './registry.js';
import {
  STAGE_PADDING,
  computeNextStackY,
  createDefaultLayout,
  normalizeLayout,
  type BioCanvasBlockLayout,
} from './layout.js';

export const BIO_CANVAS_VERSION = 1 as const;
export const MAX_BIO_CANVAS_BLOCKS = 50;
export const MAX_BIO_CANVAS_JSON_BYTES = 65_536;
export const MAX_BIO_CANVAS_BLOCK_ID_LENGTH = 64;

export {
  STAGE_WIDTH,
  STAGE_MAX_HEIGHT,
  STAGE_PADDING,
  STAGE_BLOCK_GAP,
  MIN_BLOCK_W,
  MIN_BLOCK_H,
  computeNextStackY,
  createDefaultLayout,
  normalizeLayout,
} from './layout.js';

export type { BioCanvasBlockLayout } from './layout.js';

export type BioCanvasBlock = {
  id: string;
  type: BlockType;
  layout: BioCanvasBlockLayout;
  data: Record<string, unknown>;
};

export type BioCanvasDocument = {
  version: typeof BIO_CANVAS_VERSION;
  blocks: BioCanvasBlock[];
};

export type BioCanvasImageAssets = Record<string, { assetId: string; url: string }>;

const BLOCK_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class BioCanvasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BioCanvasError';
  }
}

export function createBlockId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `block-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function parseBlockId(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.length || raw.length > MAX_BIO_CANVAS_BLOCK_ID_LENGTH) {
    return null;
  }
  if (BLOCK_ID_RE.test(raw) || /^[a-zA-Z0-9_-]+$/.test(raw)) {
    return raw;
  }
  return null;
}

function parseBlock(
  raw: unknown,
  typeCounts: Map<string, number>,
  legacyStackY: number,
): BioCanvasBlock | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = parseBlockId(o.id);
  if (!id) return null;
  if (typeof o.type !== 'string') return null;

  const descriptor = getBlockDescriptor(o.type);
  if (!descriptor) return null;

  const count = typeCounts.get(descriptor.type) ?? 0;
  if (count >= descriptor.maxPerCanvas) return null;

  const parsed = descriptor.dataSchema.safeParse(o.data ?? {});
  if (!parsed.success) return null;

  typeCounts.set(descriptor.type, count + 1);
  const layout = normalizeLayout(o.layout, descriptor, legacyStackY);

  return {
    id,
    type: descriptor.type,
    layout,
    data: parsed.data as Record<string, unknown>,
  };
}

/** Parse and validate; `null` input clears stored canvas. */
export function parseBioCanvas(input: unknown): BioCanvasDocument | null {
  if (input === null || input === undefined) return null;

  const serialized = JSON.stringify(input);
  if (serialized.length > MAX_BIO_CANVAS_JSON_BYTES) {
    throw new BioCanvasError('Canvas payload too large');
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BioCanvasError('Invalid canvas object');
  }

  const o = input as Record<string, unknown>;
  if (o.version !== BIO_CANVAS_VERSION) {
    throw new BioCanvasError('Unsupported canvas version');
  }

  if (!Array.isArray(o.blocks)) {
    throw new BioCanvasError('blocks must be an array');
  }

  if (o.blocks.length > MAX_BIO_CANVAS_BLOCKS) {
    throw new BioCanvasError(`At most ${MAX_BIO_CANVAS_BLOCKS} blocks allowed`);
  }

  const typeCounts = new Map<string, number>();
  const blocks: BioCanvasBlock[] = [];
  let legacyStackY = STAGE_PADDING;

  for (const rawBlock of o.blocks) {
    const parsed = parseBlock(rawBlock, typeCounts, legacyStackY);
    if (!parsed) {
      throw new BioCanvasError('Invalid block in canvas');
    }
    blocks.push(parsed);
    legacyStackY = parsed.layout.y + parsed.layout.h + 16;
  }

  return {
    version: BIO_CANVAS_VERSION,
    blocks,
  };
}

/** Lenient parse for live editor preview. */
export function coerceBioCanvasForRender(input: unknown): BioCanvasDocument | null {
  try {
    return parseBioCanvas(input);
  } catch {
    if (input === null || input === undefined) return null;
    if (typeof input !== 'object' || Array.isArray(input)) return null;
    const o = input as Record<string, unknown>;
    if (o.version !== BIO_CANVAS_VERSION || !Array.isArray(o.blocks)) return null;
    return {
      version: BIO_CANVAS_VERSION,
      blocks: o.blocks as BioCanvasBlock[],
    };
  }
}

export function createBlock(
  type: BlockType,
  id?: string,
  existingBlocks: BioCanvasBlock[] = [],
): BioCanvasBlock | null {
  const descriptor = getBlockDescriptor(type);
  if (!descriptor) return null;
  const stackY = computeNextStackY(existingBlocks);
  return {
    id: id ?? createBlockId(),
    type: descriptor.type,
    layout: createDefaultLayout(descriptor, stackY),
    data: descriptor.createDefault() as Record<string, unknown>,
  };
}

export function createDefaultBioCanvas(): BioCanvasDocument {
  const textBlock = createBlock('text', undefined, []);
  return {
    version: BIO_CANVAS_VERSION,
    blocks: textBlock ? [textBlock] : [],
  };
}

export function toPlainText(doc: BioCanvasDocument | null): string | null {
  if (!doc?.blocks?.length) return null;
  const parts: string[] = [];
  for (const block of doc.blocks) {
    const descriptor = getBlockDescriptor(block.type);
    if (!descriptor) continue;
    const text = descriptor.toPlainText(block.data as never);
    if (text?.trim()) parts.push(text.trim());
  }
  if (!parts.length) return null;
  const joined = parts.join('\n\n');
  return joined.length > 2000 ? joined.slice(0, 2000) : joined;
}

export function getImageBlockIds(doc: BioCanvasDocument | null): string[] {
  if (!doc?.blocks?.length) return [];
  return doc.blocks.filter((b) => b.type === 'image').map((b) => b.id);
}

export function parseBioCanvasImageAssets(input: unknown): BioCanvasImageAssets {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) return {};
  const out: BioCanvasImageAssets = {};
  for (const [blockId, val] of Object.entries(input as Record<string, unknown>)) {
    if (!blockId || !val || typeof val !== 'object' || Array.isArray(val)) continue;
    const row = val as Record<string, unknown>;
    const assetId = typeof row.assetId === 'string' ? row.assetId.trim() : '';
    const url = typeof row.url === 'string' ? row.url.trim() : '';
    if (assetId && url) out[blockId] = { assetId, url };
  }
  return out;
}

export function pruneBioCanvasImageAssets(
  doc: BioCanvasDocument | null,
  assets: BioCanvasImageAssets,
): BioCanvasImageAssets {
  const ids = new Set(getImageBlockIds(doc));
  const next: BioCanvasImageAssets = {};
  for (const id of ids) {
    if (assets[id]) next[id] = assets[id];
  }
  return next;
}

export function upsertBioCanvasImageAsset(
  existing: unknown,
  blockId: string,
  assetId: string,
  url: string,
): BioCanvasImageAssets {
  const assets = parseBioCanvasImageAssets(existing);
  return { ...assets, [blockId]: { assetId, url } };
}

export { BLOCK_DESCRIPTORS };
