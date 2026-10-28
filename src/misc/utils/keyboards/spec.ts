import {
  KEYBOARD_SENSING_TYPES,
  KEYBOARD_SWITCH_SENSING_TYPES,
  KeyboardSetupError,
  MAX_BOARD_SWITCHES,
  MAX_KEYBIND_NOTE_LENGTH,
  MAX_KEYBOARD_NAME_LENGTH,
  type BoardKeyOverrideInput,
  type BoardSpecInput,
  type BoardSwitchListInput,
  type KeyboardSensing,
  type KeyboardSwitchSensing,
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
  {id: 'switch', when: (spec) => spec.sensing !== 'membrane'},
  {id: 'actuationMm', when: (spec) => spec.sensing !== 'membrane'},
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

export function parseSwitchSensing(raw: unknown): KeyboardSwitchSensing | null {
  if (raw == null || raw === '') return null;
  if (
    typeof raw !== 'string' ||
    !KEYBOARD_SWITCH_SENSING_TYPES.includes(raw as KeyboardSwitchSensing)
  ) {
    throw new KeyboardSetupError(400, 'Invalid sensing type');
  }
  return raw as KeyboardSwitchSensing;
}

function parseOptionalColor(raw: unknown, field: string): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(raw)) {
    throw new KeyboardSetupError(400, `${field} must be a #RRGGBB value`);
  }
  return raw.toLowerCase();
}

function parseOptionalOpacity(raw: unknown, field: string): number | null {
  if (raw == null || raw === '') return null;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new KeyboardSetupError(400, `${field} must be between 0 and 1`);
  }
  return Math.round(value * 100) / 100;
}

function parseOptionalBoolean(raw: unknown, field: string): boolean | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'boolean') return raw;
  throw new KeyboardSetupError(400, `${field} must be a boolean`);
}

function parseOptionalIndex(raw: unknown, field: string, max: number): number | null {
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value >= max) {
    throw new KeyboardSetupError(400, `${field} is invalid`);
  }
  return value;
}

export function parseBoardSwitchList(raw: unknown): BoardSwitchListInput[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new KeyboardSetupError(400, 'switches must be an array');
  }
  if (raw.length > MAX_BOARD_SWITCHES) {
    throw new KeyboardSetupError(400, `At most ${MAX_BOARD_SWITCHES} switches per board`);
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new KeyboardSetupError(400, 'Invalid board switch');
    }
    const rec = item as Record<string, unknown>;
    const absent = rec.absent === true;
    if (absent) {
      return {
        id: parseOptionalId(rec.id, `switches[${index}].id`),
        absent: true,
        switchId: null,
        customSwitch: null,
        stemColor: null,
        baseColor: null,
        topColor: null,
        baseOpacity: null,
      };
    }
    return {
      id: parseOptionalId(rec.id, `switches[${index}].id`),
      absent: false,
      switchId: parseOptionalId(rec.switchId, 'switchId'),
      customSwitch: parseOptionalString(rec.customSwitch, 'customSwitch', MAX_KEYBOARD_NAME_LENGTH),
      stemColor: parseOptionalColor(rec.stemColor, 'stemColor'),
      baseColor: parseOptionalColor(rec.baseColor, 'baseColor'),
      topColor: parseOptionalColor(rec.topColor, 'topColor'),
      baseOpacity: parseOptionalOpacity(rec.baseOpacity, 'baseOpacity'),
    };
  });
}

function keyHasRapidTriggerOverride(row: BoardKeyOverrideInput): boolean {
  return (
    row.rapidTriggerSplit != null
    || row.rapidTriggerActuationMm != null
    || row.rapidTriggerPressMm != null
    || row.rapidTriggerReleaseMm != null
  );
}

function inferKeyRapidTriggerSplit(row: BoardKeyOverrideInput): BoardKeyOverrideInput {
  if (!keyHasRapidTriggerOverride(row)) return row;
  if (row.rapidTriggerSplit != null) return row;
  if (row.rapidTriggerPressMm != null || row.rapidTriggerReleaseMm != null) {
    return {...row, rapidTriggerSplit: true};
  }
  return {...row, rapidTriggerSplit: false};
}

export function parseBoardKeyOverrides(
  raw: unknown,
  switches: BoardSwitchListInput[] = [],
): BoardKeyOverrideInput[] {
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
    let periodSwitchIndex = parseOptionalIndex(
      rec.periodSwitchIndex,
      'periodSwitchIndex',
      switches.length,
    );
    if (periodSwitchIndex == null && rec.periodSwitchId != null && rec.periodSwitchId !== '') {
      const periodSwitchId = parseOptionalId(rec.periodSwitchId, 'periodSwitchId');
      const matched = switches.findIndex((row) => row.id === periodSwitchId);
      if (matched < 0) {
        throw new KeyboardSetupError(400, 'periodSwitchId does not match a board switch');
      }
      periodSwitchIndex = matched;
    }
    if (periodSwitchIndex != null && periodSwitchIndex >= switches.length) {
      throw new KeyboardSetupError(400, 'periodSwitchIndex is invalid');
    }
    const switchAbsent = rec.switchAbsent === true;
    rows.push(
      inferKeyRapidTriggerSplit({
        code,
        socketEmpty: Boolean(rec.socketEmpty),
        switchAbsent,
        switchId: parseOptionalId(rec.switchId, 'switchId'),
        customSwitch: parseOptionalString(rec.customSwitch, 'customSwitch', MAX_KEYBOARD_NAME_LENGTH),
        periodSwitchIndex: switchAbsent ? null : periodSwitchIndex,
        actuationMm: parseOptionalMm(rec.actuationMm, 'actuationMm'),
        rapidTriggerSplit: parseOptionalBoolean(rec.rapidTriggerSplit, 'rapidTriggerSplit'),
        rapidTriggerActuationMm: parseOptionalMm(
          rec.rapidTriggerActuationMm,
          'rapidTriggerActuationMm',
        ),
        rapidTriggerPressMm: parseOptionalMm(rec.rapidTriggerPressMm, 'rapidTriggerPressMm'),
        rapidTriggerReleaseMm: parseOptionalMm(rec.rapidTriggerReleaseMm, 'rapidTriggerReleaseMm'),
      }),
    );
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
    baseOpacity: parseOptionalOpacity(rec.baseOpacity, 'baseOpacity'),
    switches: parseBoardSwitchList(rec.switches),
    keyOverrides: [],
  };
  spec.keyOverrides = parseBoardKeyOverrides(rec.keyOverrides, spec.switches);
  return sanitizeBoardSpec(spec);
}

function clearKeyRapidTrigger(row: BoardKeyOverrideInput): BoardKeyOverrideInput {
  return {
    ...row,
    rapidTriggerSplit: null,
    rapidTriggerActuationMm: null,
    rapidTriggerPressMm: null,
    rapidTriggerReleaseMm: null,
  };
}

function sanitizeKeyRapidTrigger(row: BoardKeyOverrideInput): BoardKeyOverrideInput {
  if (!keyHasRapidTriggerOverride(row)) return row;
  if (row.rapidTriggerSplit) {
    return {...row, rapidTriggerActuationMm: null};
  }
  return {...row, rapidTriggerPressMm: null, rapidTriggerReleaseMm: null};
}

export function sanitizeBoardSpec(spec: BoardSpecInput): BoardSpecInput {
  const next = {...spec, switches: [...(spec.switches ?? [])], keyOverrides: [...(spec.keyOverrides ?? [])]};
  if (next.sensing === 'membrane') {
    next.switchId = null;
    next.customSwitch = null;
    next.actuationMm = null;
    next.stemColor = null;
    next.baseColor = null;
    next.topColor = null;
    next.baseOpacity = null;
    next.rapidTriggerSplit = false;
    next.rapidTriggerActuationMm = null;
    next.rapidTriggerPressMm = null;
    next.rapidTriggerReleaseMm = null;
    next.switches = [];
    next.keyOverrides = [];
    return next;
  }
  if (next.sensing !== 'hall') {
    next.rapidTriggerSplit = false;
    next.rapidTriggerActuationMm = null;
    next.rapidTriggerPressMm = null;
    next.rapidTriggerReleaseMm = null;
    next.keyOverrides = next.keyOverrides.map(clearKeyRapidTrigger);
    return next;
  }
  if (next.rapidTriggerSplit) {
    next.rapidTriggerActuationMm = null;
  } else {
    next.rapidTriggerPressMm = null;
    next.rapidTriggerReleaseMm = null;
  }
  next.keyOverrides = next.keyOverrides.map(sanitizeKeyRapidTrigger);
  return next;
}

type RapidTriggerTuple = {
  split: boolean;
  actuation: number | null;
  press: number | null;
  release: number | null;
};

function rapidTriggerKey(value: RapidTriggerTuple): string {
  return `${value.split ? 1 : 0}:${value.actuation ?? ''}:${value.press ?? ''}:${value.release ?? ''}`;
}

function boardRapidTrigger(spec: BoardSpecInput): RapidTriggerTuple {
  return {
    split: Boolean(spec.rapidTriggerSplit),
    actuation: spec.rapidTriggerActuationMm ?? null,
    press: spec.rapidTriggerPressMm ?? null,
    release: spec.rapidTriggerReleaseMm ?? null,
  };
}

function effectiveKeyRapidTrigger(
  row: BoardKeyOverrideInput | undefined,
  spec: BoardSpecInput,
): RapidTriggerTuple {
  if (!row || !keyHasRapidTriggerOverride(row)) return boardRapidTrigger(spec);
  return {
    split: Boolean(row.rapidTriggerSplit),
    actuation: row.rapidTriggerActuationMm ?? null,
    press: row.rapidTriggerPressMm ?? null,
    release: row.rapidTriggerReleaseMm ?? null,
  };
}

export function assertBoardSpecFitsGeometry(
  spec: BoardSpecInput,
  geometryCodes: Iterable<string>,
  bindableCodes: Iterable<string>,
): void {
  const known = new Set(geometryCodes);
  const bindable = new Set(bindableCodes);
  const maxSwitches = Math.min(MAX_BOARD_SWITCHES, Math.max(bindable.size, 1));
  if ((spec.switches?.length ?? 0) > maxSwitches) {
    throw new KeyboardSetupError(400, `At most ${maxSwitches} switches on this board`);
  }
  for (const row of spec.keyOverrides ?? []) {
    if (!known.has(row.code)) {
      throw new KeyboardSetupError(400, `Key ${row.code} is not on this board`);
    }
  }
}

export function promoteSharedBoardDefaults(
  spec: BoardSpecInput,
  bindableCodes: Iterable<string>,
): BoardSpecInput {
  const next = {...spec, switches: [...(spec.switches ?? [])], keyOverrides: [...(spec.keyOverrides ?? [])]};
  const empty = emptySocketCodes(next);
  const codes = [...new Set(bindableCodes)].filter((code) => !empty.has(code));
  if (!codes.length) return next;
  const byCode = new Map((next.keyOverrides ?? []).map((row) => [row.code, row]));

  const actuations = codes.map((code) => byCode.get(code)?.actuationMm ?? next.actuationMm ?? null);
  if (actuations.every((value) => value === actuations[0])) {
    next.actuationMm = actuations[0] ?? null;
  }

  const rapid = codes.map((code) => effectiveKeyRapidTrigger(byCode.get(code), next));
  if (rapid.every((value) => rapidTriggerKey(value) === rapidTriggerKey(rapid[0]))) {
    const shared = rapid[0];
    next.rapidTriggerSplit = shared.split;
    next.rapidTriggerActuationMm = shared.actuation;
    next.rapidTriggerPressMm = shared.press;
    next.rapidTriggerReleaseMm = shared.release;
  }

  const switchIndexes = codes.map((code) => byCode.get(code)?.periodSwitchIndex ?? null);
  const sharedIndex = switchIndexes[0];
  if (
    sharedIndex != null
    && switchIndexes.every((value) => value === sharedIndex)
    && next.switches[sharedIndex]
  ) {
    const shared = next.switches[sharedIndex];
    next.switchId = shared.switchId ?? null;
    next.customSwitch = shared.customSwitch ?? null;
    next.stemColor = shared.stemColor ?? null;
    next.baseColor = shared.baseColor ?? null;
    next.topColor = shared.topColor ?? null;
    next.baseOpacity = shared.baseOpacity ?? null;
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

export type LayoutSetupRecord = {
  switches: Array<Omit<BoardSwitchListInput, 'id'>>;
  keyOverrides: BoardKeyOverrideInput[];
  switchId: number | null;
  customSwitch: string | null;
  actuationMm: number | null;
  rapidTriggerSplit: boolean;
  rapidTriggerActuationMm: number | null;
  rapidTriggerPressMm: number | null;
  rapidTriggerReleaseMm: number | null;
  stemColor: string | null;
  baseColor: string | null;
  topColor: string | null;
  baseOpacity: number | null;
};

export function layoutSetupRecord(spec: BoardSpecInput): LayoutSetupRecord {
  return {
    switches: (spec.switches ?? []).map((row) => ({
      absent: Boolean(row.absent),
      switchId: row.switchId ?? null,
      customSwitch: row.customSwitch ?? null,
      stemColor: row.stemColor ?? null,
      baseColor: row.baseColor ?? null,
      topColor: row.topColor ?? null,
      baseOpacity: row.baseOpacity ?? null,
    })),
    keyOverrides: (spec.keyOverrides ?? []).map((row) => ({
      code: row.code,
      socketEmpty: Boolean(row.socketEmpty),
      switchAbsent: Boolean(row.switchAbsent),
      switchId: row.switchId ?? null,
      customSwitch: row.customSwitch ?? null,
      periodSwitchIndex: row.periodSwitchIndex ?? null,
      actuationMm: row.actuationMm ?? null,
      rapidTriggerSplit: row.rapidTriggerSplit ?? null,
      rapidTriggerActuationMm: row.rapidTriggerActuationMm ?? null,
      rapidTriggerPressMm: row.rapidTriggerPressMm ?? null,
      rapidTriggerReleaseMm: row.rapidTriggerReleaseMm ?? null,
    })),
    switchId: spec.switchId ?? null,
    customSwitch: spec.customSwitch ?? null,
    actuationMm: spec.actuationMm ?? null,
    rapidTriggerSplit: Boolean(spec.rapidTriggerSplit),
    rapidTriggerActuationMm: spec.rapidTriggerActuationMm ?? null,
    rapidTriggerPressMm: spec.rapidTriggerPressMm ?? null,
    rapidTriggerReleaseMm: spec.rapidTriggerReleaseMm ?? null,
    stemColor: spec.stemColor ?? null,
    baseColor: spec.baseColor ?? null,
    topColor: spec.topColor ?? null,
    baseOpacity: spec.baseOpacity ?? null,
  };
}

export function parseLayoutSetup(
  raw: unknown,
  geometryId: number,
  sensing: KeyboardSensing | null,
): BoardSpecInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new KeyboardSetupError(400, 'Layout setup is invalid');
  }
  return parseBoardSpecInput({
    ...(raw as Record<string, unknown>),
    geometryId,
    sensing,
    productId: null,
    customBrand: null,
    customModel: null,
    colorway: null,
    note: null,
  });
}
