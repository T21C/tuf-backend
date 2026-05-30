export const STAGE_WIDTH = 1000;
export const STAGE_HEIGHT = 1200;
export const STAGE_MAX_HEIGHT = STAGE_HEIGHT;
export const STAGE_PADDING = 24;
export const STAGE_BLOCK_GAP = 16;
export const MIN_BLOCK_W = 40;
export const MIN_BLOCK_H = 24;
export const MIN_BLOCK_ROTATION = -360;
export const MAX_BLOCK_ROTATION = 360;

const LEGACY_ALIGN = ['left', 'center', 'right'] as const;
const LEGACY_WIDTH = ['full', 'half'] as const;

export type BioCanvasBlockLayout = {
  x: number;
  y: number;
  w: number;
  h: number;
  locked: boolean;
  rotation: number;
};

export type BlockDescriptorLike = {
  defaultSize?: { w: number; h: number };
  resizeBehavior?: 'aspect' | 'widthOnly' | 'free' | 'text';
};

function clampInt(value: unknown, min: number, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function clampBlockRotation(value: unknown, fallback = 0): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_BLOCK_ROTATION, Math.max(MIN_BLOCK_ROTATION, n));
}

function isLegacyLayout(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  return 'align' in o || 'width' in o;
}

function hasFreeformLayout(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  return 'x' in o || 'y' in o || 'w' in o || 'h' in o;
}

function defaultLocked(descriptor: BlockDescriptorLike | undefined): boolean {
  return descriptor?.resizeBehavior === 'aspect';
}

export function normalizeLayout(
  raw: unknown,
  descriptor: BlockDescriptorLike | undefined,
  legacyStackY = STAGE_PADDING,
): BioCanvasBlockLayout {
  const defaultW = descriptor?.defaultSize?.w ?? 600;
  const defaultH = descriptor?.defaultSize?.h ?? 120;

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;

    if (hasFreeformLayout(o) && !isLegacyLayout(o)) {
      const w = clampInt(o.w, MIN_BLOCK_W, STAGE_WIDTH);
      const h = clampInt(o.h, MIN_BLOCK_H, STAGE_MAX_HEIGHT);
      const x = clampInt(o.x, 0, Math.max(0, STAGE_WIDTH - w));
      const y = clampInt(o.y, 0, Math.max(0, STAGE_MAX_HEIGHT - h));
      const locked =
        o.locked !== undefined ? o.locked !== false : descriptor?.resizeBehavior === 'aspect';
      const rotation = clampBlockRotation(o.rotation, 0);
      return { x, y, w, h, locked, rotation };
    }

    if (isLegacyLayout(o)) {
      const width = LEGACY_WIDTH.includes(o.width as (typeof LEGACY_WIDTH)[number])
        ? (o.width as (typeof LEGACY_WIDTH)[number])
        : 'full';
      const w = width === 'half' ? 500 : STAGE_WIDTH;
      const align = LEGACY_ALIGN.includes(o.align as (typeof LEGACY_ALIGN)[number])
        ? (o.align as (typeof LEGACY_ALIGN)[number])
        : 'center';
      let x = 0;
      if (align === 'center') x = Math.round((STAGE_WIDTH - w) / 2);
      else if (align === 'right') x = STAGE_WIDTH - w;
      const h = defaultH;
      const y = legacyStackY;
      return { x, y, w, h, locked: defaultLocked(descriptor), rotation: 0 };
    }
  }

  const w = defaultW;
  const h = defaultH;
  const x = Math.round((STAGE_WIDTH - w) / 2);
  const y = legacyStackY;
  return { x, y, w, h, locked: defaultLocked(descriptor), rotation: 0 };
}

export function createDefaultLayout(
  descriptor: BlockDescriptorLike | undefined,
  stackY = STAGE_PADDING,
): BioCanvasBlockLayout {
  return normalizeLayout(null, descriptor, stackY);
}

export function computeNextStackY(
  blocks: Array<{ layout?: BioCanvasBlockLayout }> | undefined,
): number {
  if (!Array.isArray(blocks) || blocks.length === 0) return STAGE_PADDING;
  let maxBottom = STAGE_PADDING;
  for (const block of blocks) {
    const layout = block?.layout;
    maxBottom = Math.max(maxBottom, (layout?.y ?? 0) + (layout?.h ?? 0) + STAGE_BLOCK_GAP);
  }
  return maxBottom;
}
