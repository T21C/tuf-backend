import {resolveKeyAlias} from './keys.js';
import {KeyboardSetupError, type StoredGeometryKey} from './types.js';

type KleState = {
  x: number;
  y: number;
  w: number;
  h: number;
  x2: number;
  y2: number;
  w2: number;
  h2: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function applyConfig(state: KleState, config: Record<string, unknown>): void {
  if (typeof config.x === 'number') state.x += config.x;
  if (typeof config.y === 'number') state.y += config.y;
  if (typeof config.w === 'number') state.w = config.w;
  if (typeof config.h === 'number') state.h = config.h;
  if (typeof config.x2 === 'number') state.x2 = config.x2;
  if (typeof config.y2 === 'number') state.y2 = config.y2;
  if (typeof config.w2 === 'number') state.w2 = config.w2;
  if (typeof config.h2 === 'number') state.h2 = config.h2;
}

function legendParts(raw: string): string[] {
  return raw.split('\n').map((part) => part.trim()).filter(Boolean);
}

function compactToken(token: string): string {
  return token.trim().toLocaleLowerCase().replace(/\s+/g, '');
}

function resolveLegendToken(token: string): string | null {
  return resolveKeyAlias(token) ?? resolveKeyAlias(compactToken(token));
}

const NUMPAD_LEGENDS: {base: string; marks: string[]; code: string}[] = [
  {base: '7', marks: ['home'], code: 'Numpad7'},
  {base: '8', marks: ['up', '↑'], code: 'Numpad8'},
  {base: '9', marks: ['pgup', 'pageup'], code: 'Numpad9'},
  {base: '4', marks: ['left', '←'], code: 'Numpad4'},
  {base: '6', marks: ['right', '→'], code: 'Numpad6'},
  {base: '1', marks: ['end'], code: 'Numpad1'},
  {base: '2', marks: ['down', '↓'], code: 'Numpad2'},
  {base: '3', marks: ['pgdn', 'pgdown', 'pagedown'], code: 'Numpad3'},
  {base: '0', marks: ['ins', 'insert'], code: 'Numpad0'},
  {base: '.', marks: ['del', 'delete'], code: 'NumpadDecimal'},
];

const SIDE_CODES: Record<string, string[]> = {
  shift: ['ShiftLeft', 'ShiftRight'],
  ctrl: ['ControlLeft', 'ControlRight'],
  control: ['ControlLeft', 'ControlRight'],
  win: ['MetaLeft', 'MetaRight'],
  windows: ['MetaLeft', 'MetaRight'],
  alt: ['AltLeft', 'AltRight'],
  '*': ['NumpadMultiply'],
  '+': ['NumpadAdd'],
};

const TWIN_CODE: Record<string, string> = {};
function pairCodes(left: string, right: string): void {
  TWIN_CODE[left] = right;
  TWIN_CODE[right] = left;
}
pairCodes('ShiftLeft', 'ShiftRight');
pairCodes('ControlLeft', 'ControlRight');
pairCodes('AltLeft', 'AltRight');
pairCodes('MetaLeft', 'MetaRight');
pairCodes('Enter', 'NumpadEnter');
pairCodes('Minus', 'NumpadSubtract');
pairCodes('Slash', 'NumpadDivide');
pairCodes('Period', 'NumpadDecimal');
for (let digit = 0; digit <= 9; digit += 1) pairCodes(`Digit${digit}`, `Numpad${digit}`);

function numpadComposite(legends: string[]): string | null {
  if (legends.length < 2) return null;
  const parts = new Set(legends.map(compactToken));
  for (const row of NUMPAD_LEGENDS) {
    if (!parts.has(row.base)) continue;
    if (row.marks.some((mark) => parts.has(mark))) return row.code;
  }
  return null;
}

function candidatesForLine(line: string): string[] {
  const codes: string[] = [];
  const aliased = resolveLegendToken(line);
  if (aliased) codes.push(aliased);
  for (const code of SIDE_CODES[compactToken(line)] || []) {
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

function unusedCandidate(legends: string[], used: Set<string>): string | null {
  const matches: string[] = [];
  for (let index = legends.length - 1; index >= 0; index -= 1) {
    for (const code of candidatesForLine(legends[index])) {
      if (!matches.includes(code)) matches.push(code);
      if (!used.has(code)) return code;
      const twin = TWIN_CODE[code];
      if (twin && !used.has(twin)) return twin;
    }
  }
  return matches[0] ?? null;
}

function displayLabel(legends: string[]): string {
  if (!legends.length) return ' ';
  return legends.join('\n');
}

type PendingKey = {
  legends: string[];
  code: string;
  bindable: boolean;
  assigned: boolean;
};

function assignKleCodes(items: PendingKey[], overrides: string[] | undefined): void {
  const used = new Set<string>();
  const claim = (item: PendingKey, code: string, bindable: boolean) => {
    item.code = code;
    item.bindable = bindable;
    item.assigned = true;
    if (bindable) used.add(code);
  };

  items.forEach((item, index) => {
    const override = overrides?.[index]?.trim();
    if (!override) return;
    claim(item, resolveKeyAlias(override) ?? override, true);
  });

  for (const item of items) {
    if (item.assigned || item.legends.length < 2) continue;
    const composite = numpadComposite(item.legends);
    if (composite && !used.has(composite)) claim(item, composite, true);
  }

  let custom = 0;
  const claimResolved = (item: PendingKey) => {
    const code = unusedCandidate(item.legends, used);
    if (code) {
      claim(item, code, true);
      return;
    }
    custom += 1;
    claim(item, `Custom${custom}`, false);
  };

  for (const item of items) {
    if (item.assigned || item.legends.length < 2) continue;
    claimResolved(item);
  }
  for (const item of items) {
    if (item.assigned) continue;
    if (!item.legends.length) {
      claim(item, 'Space', true);
      continue;
    }
    claimResolved(item);
  }
}

type DraftKey = PendingKey & {
  x: number;
  y: number;
  w: number;
  h: number;
  x2: number;
  y2: number;
  w2: number;
  h2: number;
};

export function importKleRaw(raw: unknown, codes?: string[]): StoredGeometryKey[] {
  if (!Array.isArray(raw)) {
    throw new KeyboardSetupError(400, 'KLE data must be an array');
  }
  const state: KleState = {x: 0, y: 0, w: 1, h: 1, x2: 0, y2: 0, w2: 0, h2: 0};
  const drafts: DraftKey[] = [];

  for (const row of raw) {
    if (isRecord(row) && !Array.isArray(row)) continue;
    if (!Array.isArray(row)) {
      throw new KeyboardSetupError(400, 'Each KLE row must be an array');
    }
    state.x = 0;
    state.w = 1;
    state.h = 1;
    state.x2 = 0;
    state.y2 = 0;
    state.w2 = 0;
    state.h2 = 0;

    for (const item of row) {
      if (isRecord(item) && typeof item !== 'string') {
        applyConfig(state, item);
        continue;
      }
      if (typeof item !== 'string') {
        throw new KeyboardSetupError(400, 'KLE keys must be strings or config objects');
      }
      drafts.push({
        legends: legendParts(item),
        code: '',
        bindable: false,
        assigned: false,
        x: state.x,
        y: state.y,
        w: state.w,
        h: state.h,
        x2: state.x2,
        y2: state.y2,
        w2: state.w2,
        h2: state.h2,
      });
      state.x += state.w;
      state.w = 1;
      state.h = 1;
      state.x2 = 0;
      state.y2 = 0;
      state.w2 = 0;
      state.h2 = 0;
    }
    state.y += 1;
  }

  if (!drafts.length) {
    throw new KeyboardSetupError(400, 'KLE data produced no keys');
  }
  assignKleCodes(drafts, codes);
  return drafts.map((draft) => {
    const stored: StoredGeometryKey = {
      code: draft.code,
      label: displayLabel(draft.legends),
      x: draft.x,
      y: draft.y,
      w: draft.w,
      h: draft.h,
      bindable: draft.bindable,
    };
    if (draft.w2 || draft.h2) {
      stored.x2 = draft.x2;
      stored.y2 = draft.y2;
      stored.w2 = draft.w2 || undefined;
      stored.h2 = draft.h2 || undefined;
    }
    return stored;
  });
}

export function parseStoredGeometryKeys(raw: unknown): StoredGeometryKey[] {
  if (!Array.isArray(raw) || !raw.length) {
    throw new KeyboardSetupError(400, 'Geometry keys are required');
  }
  const keys: StoredGeometryKey[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      throw new KeyboardSetupError(400, 'Each geometry key must be an object');
    }
    if (typeof item.code !== 'string' || !item.code.trim()) {
      throw new KeyboardSetupError(400, 'Geometry key is missing a code');
    }
    const code = item.code.trim();
    const x = Number(item.x);
    const y = Number(item.y);
    const w = item.w == null ? 1 : Number(item.w);
    const h = item.h == null ? 1 : Number(item.h);
    if (![x, y, w, h].every((n) => Number.isFinite(n) && n >= 0)) {
      throw new KeyboardSetupError(400, `Invalid geometry for ${code}`);
    }
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : code;
    const stored: StoredGeometryKey = {
      code,
      label,
      x,
      y,
      w,
      h,
      bindable: item.bindable !== false,
    };
    if (typeof item.offsetX === 'number' && Number.isFinite(item.offsetX)) {
      stored.offsetX = item.offsetX;
    }
    if (item.variant === 'display' || item.variant === 'dial') {
      stored.variant = item.variant;
    }
    keys.push(stored);
  }
  return keys;
}
