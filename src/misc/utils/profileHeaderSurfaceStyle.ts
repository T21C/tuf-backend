/** Profile header card shell: ordered DOM stack (gradients + image) with shared image settings. */

export const PROFILE_HEADER_SURFACE_STYLE_VERSION = 2 as const;
export const SURFACE_STACK_KIND_GRADIENT = 'gradient' as const;
export const SURFACE_STACK_KIND_IMAGE = 'image' as const;
export const MAX_PROFILE_HEADER_SURFACE_LAYERS = 10;
export const MAX_PROFILE_HEADER_SURFACE_STOPS = 8;
export const MIN_PROFILE_HEADER_SURFACE_STOPS = 2;
export const MAX_PROFILE_HEADER_SURFACE_JSON_BYTES = 16_384;

export const GRADIENT_LAYER_TYPES = [
  'linear',
  'radial',
  'conic',
  'repeating-linear',
  'repeating-radial',
  'repeating-conic',
] as const;

export type GradientLayerType = (typeof GRADIENT_LAYER_TYPES)[number];

export const RADIAL_SHAPES = ['circle', 'ellipse'] as const;
export const RADIAL_SIZES = [
  'closest-side',
  'closest-corner',
  'farthest-side',
  'farthest-corner',
] as const;

export const IMAGE_SIZE_PRESETS = ['cover', 'contain', 'auto'] as const;
export const IMAGE_REPEAT = ['no-repeat', 'repeat', 'repeat-x', 'repeat-y', 'space', 'round'] as const;
export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const;

export type ProfileHeaderSurfaceColorStop = {
  color: string;
  offsetPercent: number;
};

export type ProfileHeaderSurfaceGradientLayer = {
  type: GradientLayerType;
  angleDeg?: number;
  position?: { xPercent: number; yPercent: number };
  shape?: (typeof RADIAL_SHAPES)[number];
  size?: (typeof RADIAL_SIZES)[number];
  stops: ProfileHeaderSurfaceColorStop[];
};

export type ProfileHeaderSurfaceImageSize =
  | (typeof IMAGE_SIZE_PRESETS)[number]
  | { widthPercent: number; heightPercent: number };

export type ProfileHeaderSurfaceImagePosition = {
  xPercent: number;
  yPercent: number;
};

export type ProfileHeaderSurfaceImageSettings = {
  size: ProfileHeaderSurfaceImageSize;
  position: ProfileHeaderSurfaceImagePosition;
  repeat: (typeof IMAGE_REPEAT)[number];
  blendMode?: (typeof BLEND_MODES)[number];
};

export type ProfileHeaderSurfaceStackGradient = ProfileHeaderSurfaceGradientLayer & {
  kind: typeof SURFACE_STACK_KIND_GRADIENT;
  opacity?: number;
  visible?: boolean;
};

export type ProfileHeaderSurfaceStackImage = {
  kind: typeof SURFACE_STACK_KIND_IMAGE;
  opacity?: number;
  visible?: boolean;
};

export type ProfileHeaderSurfaceStackEntry =
  | ProfileHeaderSurfaceStackGradient
  | ProfileHeaderSurfaceStackImage;

export type ProfileHeaderSurfaceStyle = {
  version: typeof PROFILE_HEADER_SURFACE_STYLE_VERSION;
  stack: ProfileHeaderSurfaceStackEntry[];
  image?: ProfileHeaderSurfaceImageSettings;
};

const DANGEROUS_COLOR =
  /url\s*\(|var\s*\(|expression\s*\(|@import|javascript:|\/\*|\*\/|;|\\|<\/|<>/i;

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_COLOR =
  /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i;
const HSL_COLOR =
  /^hsla?\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function parseOpacity(raw: unknown): number {
  if (raw === undefined || raw === null) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return round1(clamp(n, 0, 1));
}

function parseVisible(raw: unknown): boolean {
  return raw !== false;
}

export function parseProfileHeaderSurfaceColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s.length || s.length > 64 || DANGEROUS_COLOR.test(s)) return null;

  if (HEX_COLOR.test(s)) return s.toLowerCase();

  const rgb = s.match(RGB_COLOR);
  if (rgb) {
    const r = clamp(Number(rgb[1]), 0, 255);
    const g = clamp(Number(rgb[2]), 0, 255);
    const b = clamp(Number(rgb[3]), 0, 255);
    if (rgb[4] !== undefined) {
      const a = clamp(Number(rgb[4]), 0, 1);
      return `rgba(${r}, ${g}, ${b}, ${round1(a)})`;
    }
    return `rgb(${r}, ${g}, ${b})`;
  }

  const hsl = s.match(HSL_COLOR);
  if (hsl) {
    const h = clamp(Number(hsl[1]), 0, 360);
    const sat = clamp(Number(hsl[2]), 0, 100);
    const l = clamp(Number(hsl[3]), 0, 100);
    if (hsl[4] !== undefined) {
      const a = clamp(Number(hsl[4]), 0, 1);
      return `hsla(${h}, ${sat}%, ${l}%, ${round1(a)})`;
    }
    return `hsl(${h}, ${sat}%, ${l}%)`;
  }

  return null;
}

function parsePercent(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return round1(clamp(n, 0, 100));
}

function parseAngle(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return round1(((n % 360) + 360) % 360);
}

function parsePosition(raw: unknown): { xPercent: number; yPercent: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const x = parsePercent(o.xPercent);
  const y = parsePercent(o.yPercent);
  if (x === null || y === null) return null;
  return { xPercent: x, yPercent: y };
}

function parseStops(raw: unknown): ProfileHeaderSurfaceColorStop[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length < MIN_PROFILE_HEADER_SURFACE_STOPS || raw.length > MAX_PROFILE_HEADER_SURFACE_STOPS) {
    return null;
  }
  const stops: ProfileHeaderSurfaceColorStop[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Record<string, unknown>;
    const color = parseProfileHeaderSurfaceColor(row.color);
    const offsetPercent = parsePercent(row.offsetPercent);
    if (!color || offsetPercent === null) return null;
    stops.push({ color, offsetPercent });
  }
  stops.sort((a, b) => a.offsetPercent - b.offsetPercent);
  return stops;
}

function parseGradientLayerFields(raw: unknown): ProfileHeaderSurfaceGradientLayer | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const type = o.type;
  if (typeof type !== 'string' || !GRADIENT_LAYER_TYPES.includes(type as GradientLayerType)) {
    return null;
  }
  const stops = parseStops(o.stops);
  if (!stops) return null;

  const layer: ProfileHeaderSurfaceGradientLayer = {
    type: type as GradientLayerType,
    stops,
  };

  if (type === 'linear' || type === 'repeating-linear') {
    layer.angleDeg = parseAngle(o.angleDeg);
  }

  if (type === 'radial' || type === 'repeating-radial' || type === 'conic' || type === 'repeating-conic') {
    const pos = parsePosition(o.position);
    layer.position = pos ?? { xPercent: 50, yPercent: 50 };
  }

  if (type === 'radial' || type === 'repeating-radial') {
    const shape = o.shape;
    layer.shape = shape === 'circle' || shape === 'ellipse' ? shape : 'ellipse';
    const size = o.size;
    if (typeof size === 'string' && RADIAL_SIZES.includes(size as (typeof RADIAL_SIZES)[number])) {
      layer.size = size as (typeof RADIAL_SIZES)[number];
    }
  }

  if (type === 'conic' || type === 'repeating-conic') {
    layer.angleDeg = parseAngle(o.angleDeg);
  }

  return layer;
}

function parseImageSize(raw: unknown): ProfileHeaderSurfaceImageSize | null {
  if (typeof raw === 'string' && IMAGE_SIZE_PRESETS.includes(raw as (typeof IMAGE_SIZE_PRESETS)[number])) {
    return raw as (typeof IMAGE_SIZE_PRESETS)[number];
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const w = parsePercent(o.widthPercent);
  const h = parsePercent(o.heightPercent);
  if (w === null || h === null) return null;
  return { widthPercent: w, heightPercent: h };
}

function parseImageSettings(raw: unknown): ProfileHeaderSurfaceImageSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const size = parseImageSize(o.size);
  const position = parsePosition(o.position);
  const repeat = o.repeat;
  if (!size || !position) return null;
  if (typeof repeat !== 'string' || !IMAGE_REPEAT.includes(repeat as (typeof IMAGE_REPEAT)[number])) {
    return null;
  }

  const image: ProfileHeaderSurfaceImageSettings = {
    size,
    position,
    repeat: repeat as (typeof IMAGE_REPEAT)[number],
  };

  const blendMode = o.blendMode;
  if (
    typeof blendMode === 'string' &&
    BLEND_MODES.includes(blendMode as (typeof BLEND_MODES)[number]) &&
    blendMode !== 'normal'
  ) {
    image.blendMode = blendMode as (typeof BLEND_MODES)[number];
  }

  return image;
}

function parseStackEntry(raw: unknown): ProfileHeaderSurfaceStackEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;

  if (kind === SURFACE_STACK_KIND_IMAGE) {
    return {
      kind: SURFACE_STACK_KIND_IMAGE,
      opacity: parseOpacity(o.opacity),
      visible: parseVisible(o.visible),
    };
  }

  if (kind === SURFACE_STACK_KIND_GRADIENT) {
    const fields = parseGradientLayerFields(o);
    if (!fields) return null;
    return {
      kind: SURFACE_STACK_KIND_GRADIENT,
      opacity: parseOpacity(o.opacity),
      visible: parseVisible(o.visible),
      ...fields,
    };
  }

  return null;
}

function parseStack(rawStack: unknown): ProfileHeaderSurfaceStackEntry[] | null {
  if (!Array.isArray(rawStack)) return null;
  if (rawStack.length > MAX_PROFILE_HEADER_SURFACE_LAYERS + 1) return null;

  let imageCount = 0;
  let gradientCount = 0;
  const stack: ProfileHeaderSurfaceStackEntry[] = [];

  for (const entry of rawStack) {
    const parsed = parseStackEntry(entry);
    if (!parsed) return null;
    if (parsed.kind === SURFACE_STACK_KIND_IMAGE) {
      imageCount += 1;
      if (imageCount > 1) return null;
    } else {
      gradientCount += 1;
      if (gradientCount > MAX_PROFILE_HEADER_SURFACE_LAYERS) return null;
    }
    stack.push(parsed);
  }

  return stack;
}

export class ProfileHeaderSurfaceStyleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileHeaderSurfaceStyleError';
  }
}

/** Parse and validate; `null` input clears stored style. */
export function parseProfileHeaderSurfaceStyle(input: unknown): ProfileHeaderSurfaceStyle | null {
  if (input === null || input === undefined) return null;

  const jsonSize = JSON.stringify(input).length;
  if (jsonSize > MAX_PROFILE_HEADER_SURFACE_JSON_BYTES) {
    throw new ProfileHeaderSurfaceStyleError('Style payload too large');
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProfileHeaderSurfaceStyleError('Invalid style object');
  }

  const o = input as Record<string, unknown>;
  if (o.version !== PROFILE_HEADER_SURFACE_STYLE_VERSION) {
    throw new ProfileHeaderSurfaceStyleError('Unsupported style version');
  }

  const stack = parseStack(o.stack);
  if (!stack || stack.length === 0) {
    throw new ProfileHeaderSurfaceStyleError('stack must be a non-empty array');
  }

  const hasImageLayer = stack.some((e) => e.kind === SURFACE_STACK_KIND_IMAGE);
  let image: ProfileHeaderSurfaceImageSettings | undefined;

  if (hasImageLayer) {
    if (o.image === undefined || o.image === null) {
      throw new ProfileHeaderSurfaceStyleError('image settings required when stack includes image layer');
    }
    const parsed = parseImageSettings(o.image);
    if (!parsed) {
      throw new ProfileHeaderSurfaceStyleError('Invalid image settings');
    }
    image = parsed;
  } else if (o.image !== undefined && o.image !== null) {
    const parsed = parseImageSettings(o.image);
    if (!parsed) {
      throw new ProfileHeaderSurfaceStyleError('Invalid image settings');
    }
    image = parsed;
  }

  return {
    version: PROFILE_HEADER_SURFACE_STYLE_VERSION,
    stack,
    ...(image ? { image } : {}),
  };
}
