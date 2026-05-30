import { z } from 'zod';
import { getBlockDescriptor, BLOCK_DESCRIPTORS, getBlockTypeLabel, type BlockType } from './registry.js';
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

export { BLOCK_TYPE_LABELS, getBlockTypeLabel } from './registry.js';

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

function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : 'value';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function describeBlockError(
  raw: unknown,
  index: number,
  typeCounts: Map<string, number>,
): string | null {
  const position = `Block ${index + 1}`;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return `${position}: must be an object`;
  }

  const o = raw as Record<string, unknown>;
  const id = parseBlockId(o.id);
  if (!id) {
    return `${position}: invalid or missing block id`;
  }

  if (typeof o.type !== 'string' || !o.type.trim()) {
    return `${position}: missing block type`;
  }

  const typeLabel = getBlockTypeLabel(o.type);
  const labeled = `${position} (${typeLabel})`;

  const descriptor = getBlockDescriptor(o.type);
  if (!descriptor) {
    return `${position}: unknown block type "${o.type}"`;
  }

  const count = typeCounts.get(descriptor.type) ?? 0;
  if (count >= descriptor.maxPerCanvas) {
    return `${labeled}: too many ${typeLabel} blocks (maximum ${descriptor.maxPerCanvas})`;
  }

  const parsed = descriptor.dataSchema.safeParse(o.data ?? {});
  if (!parsed.success) {
    return `${labeled}: ${formatZodIssues(parsed.error.issues)}`;
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

function validateCanvasStructure(input: unknown): string | null {
  if (input === null || input === undefined) return null;

  const serialized = JSON.stringify(input);
  if (serialized.length > MAX_BIO_CANVAS_JSON_BYTES) {
    return 'Canvas payload is too large';
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return 'Canvas must be an object';
  }

  const o = input as Record<string, unknown>;
  if (o.version !== BIO_CANVAS_VERSION) {
    return `Unsupported canvas version (expected ${BIO_CANVAS_VERSION})`;
  }

  if (!Array.isArray(o.blocks)) {
    return 'Canvas blocks must be an array';
  }

  if (o.blocks.length > MAX_BIO_CANVAS_BLOCKS) {
    return `Too many blocks (maximum ${MAX_BIO_CANVAS_BLOCKS})`;
  }

  return null;
}

function formatBlockErrors(errors: string[]): string {
  if (errors.length === 1) return errors[0];
  return `Canvas has ${errors.length} invalid blocks:\n${errors.map((err) => `• ${err}`).join('\n')}`;
}

/** Collect human-readable validation errors for each invalid block. */
export function collectBioCanvasBlockErrors(input: unknown): string[] {
  const structureError = validateCanvasStructure(input);
  if (structureError) return [structureError];
  if (input === null || input === undefined) return [];

  const o = input as Record<string, unknown>;
  const typeCounts = new Map<string, number>();
  const errors: string[] = [];

  for (let index = 0; index < (o.blocks as unknown[]).length; index += 1) {
    const rawBlock = (o.blocks as unknown[])[index];
    const blockError = describeBlockError(rawBlock, index, typeCounts);
    if (blockError) {
      errors.push(blockError);
      continue;
    }

    const blockObj = rawBlock as Record<string, unknown>;
    const descriptor = getBlockDescriptor(String(blockObj.type));
    if (descriptor) {
      const count = typeCounts.get(descriptor.type) ?? 0;
      typeCounts.set(descriptor.type, count + 1);
    }
  }

  return errors;
}

/** Parse and validate; `null` input clears stored canvas. */
export function parseBioCanvas(input: unknown): BioCanvasDocument | null {
  if (input === null || input === undefined) return null;

  const structureError = validateCanvasStructure(input);
  if (structureError) {
    throw new BioCanvasError(structureError);
  }

  const blockErrors = collectBioCanvasBlockErrors(input);
  if (blockErrors.length) {
    throw new BioCanvasError(formatBlockErrors(blockErrors));
  }

  const o = input as Record<string, unknown>;
  const typeCounts = new Map<string, number>();
  const blocks: BioCanvasBlock[] = [];
  let legacyStackY = STAGE_PADDING;

  for (const rawBlock of o.blocks as unknown[]) {
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
  return {
    id: id ?? createBlockId(),
    type: descriptor.type,
    layout: createDefaultLayout(descriptor),
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
