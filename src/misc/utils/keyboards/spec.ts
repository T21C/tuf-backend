import {
  KEYBOARD_SENSING_TYPES,
  KeyboardSetupError,
  MAX_KEYBIND_NOTE_LENGTH,
  MAX_KEYBOARD_NAME_LENGTH,
  type BoardKeyOverrideInput,
  type BoardSpecInput,
  type KeyboardSensing,
} from './types.js';

export type SpecFieldId =
  | 'sensing'
  | 'switch'
  | 'actuationMm'
  | 'rapidTriggerActuationMm'
  | 'rapidTriggerPressMm'
  | 'rapidTriggerReleaseMm'
  | 'colorway'
  | 'note';

export type SpecContext = {
  sensing?: KeyboardSensing | null;
  rapidTriggerSplit?: boolean | null;
};

export type SpecFieldDef = {
  id: SpecFieldId;
  when?: (spec: SpecContext) => boolean;
};

export const BOARD_SPEC_FIELDS: SpecFieldDef[] = [
  {id: 'sensing'},
  {id: 'switch'},
  {id: 'actuationMm'},
  {
    id: 'rapidTriggerActuationMm',
    when: (spec) => spec.sensing === 'hall' && !spec.rapidTriggerSplit,
  },
  {
    id: 'rapidTriggerPressMm',
    when: (spec) => spec.sensing === 'hall' && Boolean(spec.rapidTriggerSplit),
  },
  {
    id: 'rapidTriggerReleaseMm',
    when: (spec) => spec.sensing === 'hall' && Boolean(spec.rapidTriggerSplit),
  },
  {id: 'colorway'},
  {id: 'note'},
];

export function specFieldVisible(field: SpecFieldDef, spec: SpecContext): boolean {
  return field.when ? field.when(spec) : true;
}

function parseOptionalString(
  raw: unknown,
  field: string,
  max: number,
): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new KeyboardSetupError(400, `${field} must be a string`);
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new KeyboardSetupError(400, `${field} must be at most ${max} characters`);
  }
  return trimmed;
}

function parseOptionalId(raw: unknown, field: string): number | null {
  if (raw == null || raw === '') return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new KeyboardSetupError(400, `${field} is invalid`);
  }
  return id;
}

function parseOptionalMm(raw: unknown, field: string): number | null {
  if (raw == null || raw === '') return null;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 8) {
    throw new KeyboardSetupError(400, `${field} must be a millimetre value between 0 and 8`);
  }
  return Math.round(value * 100) / 100;
}

function parseSensing(raw: unknown): KeyboardSensing | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' || !KEYBOARD_SENSING_TYPES.includes(raw as KeyboardSensing)) {
    throw new KeyboardSetupError(400, 'Invalid sensing type');
  }
  return raw as KeyboardSensing;
}

function parseOptionalColor(raw: unknown, field: string): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(raw)) {
    throw new KeyboardSetupError(400, `${field} must be a #RRGGBB value`);
  }
  return raw.toLowerCase();
}

export function parseBoardKeyOverrides(raw: unknown): BoardKeyOverrideInput[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new KeyboardSetupError(400, 'keyOverrides must be an array');
  }
  const seen = new Set<string>();
  const rows: BoardKeyOverrideInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new KeyboardSetupError(400, 'Invalid key override');
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.code !== 'string' || !rec.code.trim()) {
      throw new KeyboardSetupError(400, 'Key override is missing a code');
    }
    const code = rec.code.trim();
    if (seen.has(code)) continue;
    seen.add(code);
    const socketEmpty = Boolean(rec.socketEmpty);
    rows.push({
      code,
      socketEmpty,
      switchId: parseOptionalId(rec.switchId, 'switchId'),
      customSwitch: parseOptionalString(rec.customSwitch, 'customSwitch', MAX_KEYBOARD_NAME_LENGTH),
    });
  }
  return rows;
}

export function parseBoardSpecInput(raw: unknown): BoardSpecInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new KeyboardSetupError(400, 'Board spec is required');
  }
  const rec = raw as Record<string, unknown>;
  const geometryId = Number(rec.geometryId);
  if (!Number.isInteger(geometryId) || geometryId <= 0) {
    throw new KeyboardSetupError(400, 'geometryId is required');
  }
  const sensing = parseSensing(rec.sensing);
  const spec: BoardSpecInput = {
    geometryId,
    productId: parseOptionalId(rec.productId, 'productId'),
    customBrand: parseOptionalString(rec.customBrand, 'customBrand', MAX_KEYBOARD_NAME_LENGTH),
    customModel: parseOptionalString(rec.customModel, 'customModel', MAX_KEYBOARD_NAME_LENGTH),
    sensing,
    switchId: parseOptionalId(rec.switchId, 'switchId'),
    customSwitch: parseOptionalString(rec.customSwitch, 'customSwitch', MAX_KEYBOARD_NAME_LENGTH),
    actuationMm: parseOptionalMm(rec.actuationMm, 'actuationMm'),
    rapidTriggerSplit: Boolean(rec.rapidTriggerSplit),
    rapidTriggerActuationMm: parseOptionalMm(
      rec.rapidTriggerActuationMm,
      'rapidTriggerActuationMm',
    ),
    rapidTriggerPressMm: parseOptionalMm(rec.rapidTriggerPressMm, 'rapidTriggerPressMm'),
    rapidTriggerReleaseMm: parseOptionalMm(rec.rapidTriggerReleaseMm, 'rapidTriggerReleaseMm'),
    colorway: parseOptionalString(rec.colorway, 'colorway', MAX_KEYBOARD_NAME_LENGTH),
    note: parseOptionalString(rec.note, 'note', MAX_KEYBIND_NOTE_LENGTH),
    stemColor: parseOptionalColor(rec.stemColor, 'stemColor'),
    baseColor: parseOptionalColor(rec.baseColor, 'baseColor'),
    topColor: parseOptionalColor(rec.topColor, 'topColor'),
    keyOverrides: parseBoardKeyOverrides(rec.keyOverrides),
  };
  return sanitizeBoardSpec(spec);
}

export function sanitizeBoardSpec(spec: BoardSpecInput): BoardSpecInput {
  const next = {...spec};
  if (next.sensing !== 'hall') {
    next.rapidTriggerSplit = false;
    next.rapidTriggerActuationMm = null;
    next.rapidTriggerPressMm = null;
    next.rapidTriggerReleaseMm = null;
    return next;
  }
  if (next.rapidTriggerSplit) {
    next.rapidTriggerActuationMm = null;
  } else {
    next.rapidTriggerPressMm = null;
    next.rapidTriggerReleaseMm = null;
  }
  return next;
}

export function emptySocketCodes(spec: BoardSpecInput): Set<string> {
  const codes = new Set<string>();
  for (const row of spec.keyOverrides ?? []) {
    if (row.socketEmpty) codes.add(row.code);
  }
  return codes;
}
