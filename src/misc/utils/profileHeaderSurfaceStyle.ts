/** Profile header card shell: ordered DOM stack (gradients + images) with per-layer image settings. */

export const PROFILE_HEADER_SURFACE_STYLE_VERSION = 3 as const;
export const SURFACE_STACK_KIND_GRADIENT = 'gradient' as const;
export const SURFACE_STACK_KIND_IMAGE = 'image' as const;
export const MAX_PROFILE_HEADER_SURFACE_LAYER_LABEL_LENGTH = 32;
export const MAX_PROFILE_HEADER_SURFACE_STACK_ENTRY_ID_LENGTH = 64;
export const MAX_PROFILE_HEADER_SURFACE_STACK_ENTRIES = 15;
export const MAX_PROFILE_HEADER_SURFACE_IMAGE_LAYERS = 10;
/** @deprecated Use MAX_PROFILE_HEADER_SURFACE_STACK_ENTRIES */
export const MAX_PROFILE_HEADER_SURFACE_LAYERS = MAX_PROFILE_HEADER_SURFACE_STACK_ENTRIES;
export const MAX_PROFILE_HEADER_SURFACE_STOPS = 8;
export const MIN_PROFILE_HEADER_SURFACE_STOPS = 2;
export const MAX_PROFILE_HEADER_SURFACE_JSON_BYTES = 32_768;

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

export const IMAGE_DIMENSION_PERCENT_MIN = 0;
export const IMAGE_DIMENSION_PERCENT_MAX = 300;
export const IMAGE_DIMENSION_PIXEL_MIN = 0;
export const IMAGE_DIMENSION_PIXEL_MAX = 4000;
export const IMAGE_SIZE_OFFSET_UNITS = ['percent', 'pixel'] as const;
export const IMAGE_REPEAT_TILE = IMAGE_REPEAT.filter((r) => r !== 'no-repeat');

export const IMAGE_POSITION_PERCENT_MIN = -100;
export const IMAGE_POSITION_PERCENT_MAX = 200;
export const IMAGE_POSITION_PIXEL_MIN = -1000;
export const IMAGE_POSITION_PIXEL_MAX = 1000;
export const IMAGE_POSITION_OFFSET_UNITS = ['percent', 'pixel'] as const;
export const IMAGE_POSITION_HORIZONTAL_KEYWORDS = ['left', 'center', 'right'] as const;
export const IMAGE_POSITION_VERTICAL_KEYWORDS = ['top', 'center', 'bottom'] as const;

export type ImagePositionHorizontalSide = (typeof IMAGE_POSITION_HORIZONTAL_KEYWORDS)[number];
export type ImagePositionVerticalSide = (typeof IMAGE_POSITION_VERTICAL_KEYWORDS)[number];
export type ImagePositionOffsetUnit = (typeof IMAGE_POSITION_OFFSET_UNITS)[number];

export type ProfileHeaderSurfaceImagePositionAxis = {
  side: ImagePositionHorizontalSide | ImagePositionVerticalSide;
  unit: ImagePositionOffsetUnit;
  value: number;
};

export type ProfileHeaderSurfaceImagePosition = {
  x: ProfileHeaderSurfaceImagePositionAxis & { side: ImagePositionHorizontalSide };
  y: ProfileHeaderSurfaceImagePositionAxis & { side: ImagePositionVerticalSide };
};

export function createDefaultImagePosition(): ProfileHeaderSurfaceImagePosition {
  return {
    x: { side: 'center', unit: 'percent', value: 0 },
    y: { side: 'center', unit: 'percent', value: 0 },
  };
}

export const PAD_FROM_TOP_OFFSET_UNITS = IMAGE_SIZE_OFFSET_UNITS;
export const PAD_FROM_TOP_PERCENT_MIN = IMAGE_POSITION_PERCENT_MIN;
export const PAD_FROM_TOP_PERCENT_MAX = IMAGE_POSITION_PERCENT_MAX;
export const PAD_FROM_TOP_PIXEL_MIN = IMAGE_POSITION_PIXEL_MIN;
export const PAD_FROM_TOP_PIXEL_MAX = IMAGE_POSITION_PIXEL_MAX;

export type ProfileHeaderSurfacePadFromTop = {
  unit: ImageSizeOffsetUnit;
  value: number;
};

export function createDefaultPadFromTop(): ProfileHeaderSurfacePadFromTop {
  return { unit: 'pixel', value: 0 };
}

function clampPadFromTopValue(value: number, unit: ImageSizeOffsetUnit): number {
  if (unit === 'pixel') {
    return Math.min(PAD_FROM_TOP_PIXEL_MAX, Math.max(PAD_FROM_TOP_PIXEL_MIN, Math.round(value)));
  }
  const rounded = Math.round(value * 10) / 10;
  return Math.min(PAD_FROM_TOP_PERCENT_MAX, Math.max(PAD_FROM_TOP_PERCENT_MIN, rounded));
}

export function normalizePadFromTop(raw: unknown): ProfileHeaderSurfacePadFromTop {
  if (!raw || typeof raw !== 'object') {
    return createDefaultPadFromTop();
  }
  const o = raw as Record<string, unknown>;
  const unit: ImageSizeOffsetUnit = o.unit === 'pixel' ? 'pixel' : 'percent';
  const n = Number(o.value);
  const value = Number.isFinite(n) ? clampPadFromTopValue(n, unit) : 0;
  return { unit, value };
}

function parsePadFromTop(raw: unknown): ProfileHeaderSurfacePadFromTop | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') return null;
  const pad = normalizePadFromTop(raw);
  if (!PAD_FROM_TOP_OFFSET_UNITS.includes(pad.unit)) return null;
  return pad;
}

export function isImageTilingEnabled(repeat: string): boolean {
  return repeat !== 'no-repeat';
}
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
  blendMode?: (typeof BLEND_MODES)[number];
};

export type ProfileHeaderSurfaceImageSizeFit = (typeof IMAGE_SIZE_PRESETS)[number];

export type ImageSizeOffsetUnit = (typeof IMAGE_SIZE_OFFSET_UNITS)[number];

export type ProfileHeaderSurfaceImageSizeDimensionAxis = {
  unit: ImageSizeOffsetUnit;
  value: number;
};

export type ProfileHeaderSurfaceImageSizeDimensions = {
  width: ProfileHeaderSurfaceImageSizeDimensionAxis;
  height: ProfileHeaderSurfaceImageSizeDimensionAxis;
};

export function createDefaultImageSizeDimensions(): ProfileHeaderSurfaceImageSizeDimensions {
  return {
    width: { unit: 'percent', value: 100 },
    height: { unit: 'percent', value: 100 },
  };
}

export type ProfileHeaderSurfaceImageSettings = {
  sizeFit: ProfileHeaderSurfaceImageSizeFit;
  sizeDimensions: ProfileHeaderSurfaceImageSizeDimensions;
  /** When true, render `background-size` as a single % (height auto); fit keyword at 100%. */
  sizeDimensionsLinked?: boolean;
  position: ProfileHeaderSurfaceImagePosition;
  repeat: (typeof IMAGE_REPEAT)[number];
  blendMode?: (typeof BLEND_MODES)[number];
  /** Shifts the layer down via CSS `top` (px or % of the surface box). */
  padFromTop?: ProfileHeaderSurfacePadFromTop;
};

export type ProfileHeaderSurfaceStackEntryBase = {
  id: string;
  label?: string;
  opacity?: number;
  visible?: boolean;
};

export type ProfileHeaderSurfaceStackGradient = ProfileHeaderSurfaceStackEntryBase &
  ProfileHeaderSurfaceGradientLayer & {
    kind: typeof SURFACE_STACK_KIND_GRADIENT;
  };

export type ProfileHeaderSurfaceStackImage = ProfileHeaderSurfaceStackEntryBase & {
  kind: typeof SURFACE_STACK_KIND_IMAGE;
};

export type ProfileHeaderSurfaceStackEntry =
  | ProfileHeaderSurfaceStackGradient
  | ProfileHeaderSurfaceStackImage;

export type ProfileHeaderSurfaceImageAssets = Record<
  string,
  { assetId: string; url: string }
>;

export type ProfileHeaderSurfaceStyle = {
  version: typeof PROFILE_HEADER_SURFACE_STYLE_VERSION;
  stack: ProfileHeaderSurfaceStackEntry[];
  images?: Record<string, ProfileHeaderSurfaceImageSettings>;
};

export function getImageStackEntryIds(stack: ProfileHeaderSurfaceStackEntry[]): string[] {
  return stack.filter((e) => e.kind === SURFACE_STACK_KIND_IMAGE).map((e) => e.id);
}

export function countImageStackEntries(stack: ProfileHeaderSurfaceStackEntry[]): number {
  return stack.filter((e) => e.kind === SURFACE_STACK_KIND_IMAGE).length;
}

const DANGEROUS_COLOR =
  /url\s*\(|var\s*\(|expression\s*\(|@import|javascript:|\/\*|\*\/|;|\\|<\/|<>/i;

const STACK_ENTRY_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STACK_ENTRY_ID_FALLBACK_RE = /^[a-zA-Z0-9_-]+$/;
const DANGEROUS_LABEL =
  /url\s*\(|var\s*\(|expression\s*\(|@import|javascript:|\/\*|\*\/|;|\\|<\/|<>/i;

function createStackEntryId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `layer-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function parseStackId(raw: unknown, assignIfMissing: boolean): string | null {
  if (
    typeof raw === 'string' &&
    raw.length > 0 &&
    raw.length <= MAX_PROFILE_HEADER_SURFACE_STACK_ENTRY_ID_LENGTH
  ) {
    if (STACK_ENTRY_ID_RE.test(raw) || STACK_ENTRY_ID_FALLBACK_RE.test(raw)) {
      return raw;
    }
  }
  return assignIfMissing ? createStackEntryId() : null;
}

function parseStackLabel(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s.length || s.length > MAX_PROFILE_HEADER_SURFACE_LAYER_LABEL_LENGTH) return null;
  if (DANGEROUS_LABEL.test(s)) return null;
  return s;
}

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

function parsePositionPercent(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return round1(n);
}

function parseAngle(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return round1(((n % 360) + 360) % 360);
}

function parseGradientPosition(raw: unknown): { xPercent: number; yPercent: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const x = parsePositionPercent(o.xPercent);
  const y = parsePositionPercent(o.yPercent);
  if (x === null || y === null) return null;
  return { xPercent: x, yPercent: y };
}

function clampImagePositionOffset(value: number, unit: ImagePositionOffsetUnit): number {
  if (unit === 'pixel') {
    return Math.min(
      IMAGE_POSITION_PIXEL_MAX,
      Math.max(IMAGE_POSITION_PIXEL_MIN, Math.round(value)),
    );
  }
  return round1(Math.min(IMAGE_POSITION_PERCENT_MAX, Math.max(IMAGE_POSITION_PERCENT_MIN, value)));
}

function parseImagePositionAxisOffset(raw: unknown, unit: ImagePositionOffsetUnit): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return clampImagePositionOffset(n, unit);
}

function parseImagePositionAxis(
  raw: unknown,
  axis: 'x' | 'y',
): ProfileHeaderSurfaceImagePositionAxis {
  const sides: readonly string[] =
    axis === 'x' ? IMAGE_POSITION_HORIZONTAL_KEYWORDS : IMAGE_POSITION_VERTICAL_KEYWORDS;
  const fallback =
    axis === 'x'
      ? ({ side: 'center' as const, unit: 'percent' as const, value: 0 })
      : ({ side: 'center' as const, unit: 'percent' as const, value: 0 });

  if (!raw || typeof raw !== 'object') {
    return { ...fallback };
  }

  const o = raw as Record<string, unknown>;
  let side = o.side;
  if (typeof side !== 'string' || !sides.includes(side)) {
    side = fallback.side;
  }

  const unit: ImagePositionOffsetUnit = o.unit === 'pixel' ? 'pixel' : 'percent';
  const value = parseImagePositionAxisOffset(o.value, unit);

  return {
    side: side as ImagePositionHorizontalSide | ImagePositionVerticalSide,
    unit,
    value,
  };
}

function parseImagePosition(raw: unknown): ProfileHeaderSurfaceImagePosition | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!o.x || typeof o.x !== 'object' || !o.y || typeof o.y !== 'object') return null;

  const position = {
    x: parseImagePositionAxis(o.x, 'x') as ProfileHeaderSurfaceImagePosition['x'],
    y: parseImagePositionAxis(o.y, 'y') as ProfileHeaderSurfaceImagePosition['y'],
  };
  if (
    !IMAGE_POSITION_HORIZONTAL_KEYWORDS.includes(position.x.side) ||
    !IMAGE_POSITION_VERTICAL_KEYWORDS.includes(position.y.side) ||
    !IMAGE_POSITION_OFFSET_UNITS.includes(position.x.unit) ||
    !IMAGE_POSITION_OFFSET_UNITS.includes(position.y.unit)
  ) {
    return null;
  }
  return position;
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
    const pos = parseGradientPosition(o.position);
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

  const blendMode = o.blendMode;
  if (
    typeof blendMode === 'string' &&
    BLEND_MODES.includes(blendMode as (typeof BLEND_MODES)[number]) &&
    blendMode !== 'normal'
  ) {
    layer.blendMode = blendMode as (typeof BLEND_MODES)[number];
  }

  return layer;
}

function clampImageSizeValue(value: number, unit: ImageSizeOffsetUnit): number {
  if (unit === 'pixel') {
    return Math.min(
      IMAGE_DIMENSION_PIXEL_MAX,
      Math.max(IMAGE_DIMENSION_PIXEL_MIN, Math.round(value)),
    );
  }
  return round1(Math.min(IMAGE_DIMENSION_PERCENT_MAX, Math.max(IMAGE_DIMENSION_PERCENT_MIN, value)));
}

function parseImageSizeAxisValue(raw: unknown, unit: ImageSizeOffsetUnit): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 100;
  return clampImageSizeValue(n, unit);
}

function parseImageSizeDimensionAxis(
  raw: unknown,
): ProfileHeaderSurfaceImageSizeDimensionAxis {
  if (!raw || typeof raw !== 'object') {
    return { unit: 'percent', value: 100 };
  }
  const o = raw as Record<string, unknown>;
  const unit: ImageSizeOffsetUnit = o.unit === 'pixel' ? 'pixel' : 'percent';
  const value = parseImageSizeAxisValue(o.value, unit);
  return { unit, value };
}

function parseImageSizeFit(raw: unknown): ProfileHeaderSurfaceImageSizeFit {
  if (typeof raw === 'string' && IMAGE_SIZE_PRESETS.includes(raw as ProfileHeaderSurfaceImageSizeFit)) {
    return raw as ProfileHeaderSurfaceImageSizeFit;
  }
  return 'cover';
}

function parseImageSizeDimensions(raw: unknown): ProfileHeaderSurfaceImageSizeDimensions | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!o.width || typeof o.width !== 'object' || !o.height || typeof o.height !== 'object') {
    return null;
  }

  const width = parseImageSizeDimensionAxis(o.width);
  const height = parseImageSizeDimensionAxis(o.height);
  if (
    !IMAGE_SIZE_OFFSET_UNITS.includes(width.unit) ||
    !IMAGE_SIZE_OFFSET_UNITS.includes(height.unit)
  ) {
    return null;
  }
  return { width, height };
}

function parseImageSettings(raw: unknown): ProfileHeaderSurfaceImageSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const sizeFit = parseImageSizeFit(o.sizeFit);
  const sizeDimensions = parseImageSizeDimensions(o.sizeDimensions);
  const position = parseImagePosition(o.position);
  const repeat = o.repeat;
  if (!sizeDimensions || !position) return null;
  if (typeof repeat !== 'string' || !IMAGE_REPEAT.includes(repeat as (typeof IMAGE_REPEAT)[number])) {
    return null;
  }

  const image: ProfileHeaderSurfaceImageSettings = {
    sizeFit,
    sizeDimensions,
    position,
    repeat: repeat as (typeof IMAGE_REPEAT)[number],
  };

  if (o.sizeDimensionsLinked === true) {
    image.sizeDimensionsLinked = true;
  }

  const blendMode = o.blendMode;
  if (
    typeof blendMode === 'string' &&
    BLEND_MODES.includes(blendMode as (typeof BLEND_MODES)[number]) &&
    blendMode !== 'normal'
  ) {
    image.blendMode = blendMode as (typeof BLEND_MODES)[number];
  }

  const padFromTop = parsePadFromTop(o.padFromTop);
  if (padFromTop === null) return null;
  if (padFromTop) {
    image.padFromTop = padFromTop;
  }

  return image;
}

function parseStackEntry(raw: unknown): ProfileHeaderSurfaceStackEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  const id = parseStackId(o.id, true);
  if (!id) return null;
  const label = parseStackLabel(o.label);
  if (label === null) return null;

  if (kind === SURFACE_STACK_KIND_IMAGE) {
    return {
      id,
      kind: SURFACE_STACK_KIND_IMAGE,
      opacity: parseOpacity(o.opacity),
      visible: parseVisible(o.visible),
      ...(label ? { label } : {}),
    };
  }

  if (kind === SURFACE_STACK_KIND_GRADIENT) {
    const fields = parseGradientLayerFields(o);
    if (!fields) return null;
    return {
      id,
      kind: SURFACE_STACK_KIND_GRADIENT,
      opacity: parseOpacity(o.opacity),
      visible: parseVisible(o.visible),
      ...(label ? { label } : {}),
      ...fields,
    };
  }

  return null;
}

function parseStack(rawStack: unknown): ProfileHeaderSurfaceStackEntry[] | null {
  if (!Array.isArray(rawStack)) return null;
  if (rawStack.length === 0 || rawStack.length > MAX_PROFILE_HEADER_SURFACE_STACK_ENTRIES) {
    return null;
  }

  let imageCount = 0;
  const stack: ProfileHeaderSurfaceStackEntry[] = [];

  for (const entry of rawStack) {
    const parsed = parseStackEntry(entry);
    if (!parsed) return null;
    if (parsed.kind === SURFACE_STACK_KIND_IMAGE) {
      imageCount += 1;
      if (imageCount > MAX_PROFILE_HEADER_SURFACE_IMAGE_LAYERS) return null;
    }
    stack.push(parsed);
  }

  return stack;
}

function parseImagesMap(
  rawImages: unknown,
  imageIds: string[],
): Record<string, ProfileHeaderSurfaceImageSettings> | undefined | null {
  if (imageIds.length === 0) {
    if (rawImages !== undefined && rawImages !== null) return null;
    return undefined;
  }
  if (!rawImages || typeof rawImages !== 'object' || Array.isArray(rawImages)) return null;

  const o = rawImages as Record<string, unknown>;
  const images: Record<string, ProfileHeaderSurfaceImageSettings> = {};

  for (const id of imageIds) {
    const parsed = parseImageSettings(o[id]);
    if (!parsed) return null;
    images[id] = parsed;
  }

  const keys = Object.keys(o).sort();
  const expected = [...imageIds].sort();
  if (keys.length !== expected.length || keys.some((k, i) => k !== expected[i])) {
    return null;
  }

  return images;
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
  if (o.image !== undefined && o.image !== null) {
    throw new ProfileHeaderSurfaceStyleError('top-level image settings are not supported');
  }

  const stack = parseStack(o.stack);
  if (!stack || stack.length === 0) {
    throw new ProfileHeaderSurfaceStyleError('stack must be a non-empty array');
  }

  const imageIds = getImageStackEntryIds(stack);
  const images = parseImagesMap(o.images, imageIds);
  if (images === null) {
    throw new ProfileHeaderSurfaceStyleError('Invalid image settings map');
  }

  return {
    version: PROFILE_HEADER_SURFACE_STYLE_VERSION,
    stack,
    ...(images ? { images } : {}),
  };
}

export function parseProfileHeaderSurfaceImageAssets(
  input: unknown,
): ProfileHeaderSurfaceImageAssets {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  const out: ProfileHeaderSurfaceImageAssets = {};
  for (const [layerId, val] of Object.entries(input as Record<string, unknown>)) {
    if (!layerId || !val || typeof val !== 'object') continue;
    const row = val as Record<string, unknown>;
    const assetId = typeof row.assetId === 'string' ? row.assetId.trim() : '';
    const url = typeof row.url === 'string' ? row.url.trim() : '';
    if (assetId && url) out[layerId] = { assetId, url };
  }
  return out;
}
