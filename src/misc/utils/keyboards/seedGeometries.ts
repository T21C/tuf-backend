import type {GeometrySeed, StoredGeometryKey} from './types.js';

type HandoffKey = {
  code: string;
  label: string;
  col: number;
  row: number;
  width?: number;
  height?: number;
  bindable?: boolean;
  offsetX?: number;
  variant?: StoredGeometryKey['variant'];
  fullOnly?: boolean;
};

const FULL_GAP = 10 / 44;
const NINETY_SIX_GAP = 2 / 44;

function yWithGap(row: number, gap: number): number {
  if (row <= 1) return 0;
  return row - 2 + gap;
}

function storedFromHandoff(key: HandoffKey, y: number): StoredGeometryKey {
  const stored: StoredGeometryKey = {
    code: key.code,
    label: key.label,
    x: (key.col - 1) / 2,
    y,
    w: (key.width ?? 2) / 2,
    h: key.height ?? 1,
    bindable: key.bindable !== false,
  };
  if (key.offsetX) stored.offsetX = key.offsetX;
  if (key.variant) stored.variant = key.variant;
  return stored;
}

function compactKey(
  code: string,
  x: number,
  row: number,
  width = 1,
  height = 1,
  extras: Partial<HandoffKey> = {},
): HandoffKey {
  return {
    code,
    label: extras.label ?? code,
    col: 1 + x * 2,
    row,
    width: width * 2,
    height: height === 1 ? undefined : height,
    bindable: extras.bindable,
    offsetX: extras.offsetX,
    variant: extras.variant,
  };
}

function compactSeries(codes: string[], startX: number, row: number): HandoffKey[] {
  return codes.map((code, index) => compactKey(code, startX + index, row));
}

function decorativeKey(
  code: string,
  label: string,
  x: number,
  row: number,
  width = 1,
  variant?: StoredGeometryKey['variant'],
): HandoffKey {
  return compactKey(code, x, row, width, 1, {label, bindable: false, variant});
}

const LETTER_LABELS: Record<string, string> = Object.fromEntries(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => [`Key${letter}`, letter]),
);

function withLabels(keys: HandoffKey[], labels: Record<string, string>): HandoffKey[] {
  return keys.map((key) => ({...key, label: labels[key.code] ?? key.label}));
}

const COMMON_LABELS: Record<string, string> = {
  Escape: 'Esc',
  PrintScreen: 'Print\nScreen',
  ScrollLock: 'Scroll\nLock',
  Pause: 'Pause',
  AudioVolumeMute: 'Mute',
  AudioVolumeDown: 'Vol −',
  AudioVolumeUp: 'Vol +',
  Calculator: 'Calc',
  Backquote: '`',
  Minus: '−',
  Equal: '=',
  Backspace: 'Backspace',
  Insert: 'Insert',
  Home: 'Home',
  PageUp: 'PgUp',
  NumLock: 'Num\nLock',
  NumpadDivide: '/',
  NumpadMultiply: '×',
  NumpadSubtract: '−',
  Tab: 'Tab',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '₩',
  Delete: 'Delete',
  End: 'End',
  PageDown: 'PgDn',
  CapsLock: 'Caps Lock',
  Semicolon: ';',
  Quote: "'",
  Enter: 'Enter',
  ShiftLeft: 'Shift',
  Comma: ',',
  Period: '.',
  Slash: '/',
  ShiftRight: 'Shift',
  ArrowUp: '↑',
  NumpadAdd: '+',
  NumpadEnter: 'Enter',
  ControlLeft: 'Ctrl',
  MetaLeft: 'Win',
  AltLeft: 'Alt',
  Space: '',
  AltRight: 'RAlt',
  MetaRight: 'Win',
  ContextMenu: 'Menu',
  ControlRight: 'Ctrl',
  ArrowLeft: '←',
  ArrowDown: '↓',
  ArrowRight: '→',
  NumpadDecimal: '.',
  Fn: 'Fn',
  ...LETTER_LABELS,
  Digit1: '1',
  Digit2: '2',
  Digit3: '3',
  Digit4: '4',
  Digit5: '5',
  Digit6: '6',
  Digit7: '7',
  Digit8: '8',
  Digit9: '9',
  Digit0: '0',
  Numpad0: '0',
  Numpad1: '1',
  Numpad2: '2',
  Numpad3: '3',
  Numpad4: '4',
  Numpad5: '5',
  Numpad6: '6',
  Numpad7: '7',
  Numpad8: '8',
  Numpad9: '9',
};

const fullKeys: HandoffKey[] = withLabels(
  [
    {code: 'Escape', label: 'Esc', col: 1, row: 1},
    {code: 'F1', label: 'F1', col: 5, row: 1},
    {code: 'F2', label: 'F2', col: 7, row: 1},
    {code: 'F3', label: 'F3', col: 9, row: 1},
    {code: 'F4', label: 'F4', col: 11, row: 1},
    {code: 'F5', label: 'F5', col: 14, row: 1},
    {code: 'F6', label: 'F6', col: 16, row: 1},
    {code: 'F7', label: 'F7', col: 18, row: 1},
    {code: 'F8', label: 'F8', col: 20, row: 1},
    {code: 'F9', label: 'F9', col: 23, row: 1},
    {code: 'F10', label: 'F10', col: 25, row: 1},
    {code: 'F11', label: 'F11', col: 27, row: 1},
    {code: 'F12', label: 'F12', col: 29, row: 1},
    {code: 'PrintScreen', label: 'Print\nScreen', col: 31.5, row: 1},
    {code: 'ScrollLock', label: 'Scroll\nLock', col: 33.5, row: 1},
    {code: 'Pause', label: 'Pause', col: 35.5, row: 1},
    {code: 'AudioVolumeMute', label: 'Mute', col: 38, row: 1, fullOnly: true},
    {code: 'AudioVolumeDown', label: 'Vol −', col: 40, row: 1, fullOnly: true},
    {code: 'AudioVolumeUp', label: 'Vol +', col: 42, row: 1, fullOnly: true},
    {code: 'Calculator', label: 'Calc', col: 44, row: 1, fullOnly: true},
    {code: 'Backquote', label: '`', col: 1, row: 3},
    ...['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((label, index) => ({
      code: `Digit${label}`,
      label,
      col: 3 + index * 2,
      row: 3,
    })),
    {code: 'Minus', label: '−', col: 23, row: 3},
    {code: 'Equal', label: '=', col: 25, row: 3},
    {code: 'Backspace', label: 'Backspace', col: 27, row: 3, width: 4},
    {code: 'Insert', label: 'Insert', col: 31.5, row: 3},
    {code: 'Home', label: 'Home', col: 33.5, row: 3},
    {code: 'PageUp', label: 'PgUp', col: 35.5, row: 3},
    {code: 'NumLock', label: 'Num\nLock', col: 38, row: 3, fullOnly: true},
    {code: 'NumpadDivide', label: '/', col: 40, row: 3, fullOnly: true},
    {code: 'NumpadMultiply', label: '×', col: 42, row: 3, fullOnly: true},
    {code: 'NumpadSubtract', label: '−', col: 44, row: 3, fullOnly: true},
    {code: 'Tab', label: 'Tab', col: 1, row: 4, width: 3},
    ...'QWERTYUIOP'.split('').map((label, index) => ({
      code: `Key${label}`,
      label,
      col: 4 + index * 2,
      row: 4,
    })),
    {code: 'BracketLeft', label: '[', col: 24, row: 4},
    {code: 'BracketRight', label: ']', col: 26, row: 4},
    {code: 'Backslash', label: '₩', col: 28, row: 4, width: 3},
    {code: 'Delete', label: 'Delete', col: 31.5, row: 4},
    {code: 'End', label: 'End', col: 33.5, row: 4},
    {code: 'PageDown', label: 'PgDn', col: 35.5, row: 4},
    {code: 'Numpad7', label: '7', col: 38, row: 4, fullOnly: true},
    {code: 'Numpad8', label: '8', col: 40, row: 4, fullOnly: true},
    {code: 'Numpad9', label: '9', col: 42, row: 4, fullOnly: true},
    {code: 'NumpadAdd', label: '+', col: 44, row: 4, height: 2, fullOnly: true},
    {code: 'CapsLock', label: 'Caps Lock', col: 1, row: 5, width: 4},
    ...'ASDFGHJKL'.split('').map((label, index) => ({
      code: `Key${label}`,
      label,
      col: 5 + index * 2,
      row: 5,
    })),
    {code: 'Semicolon', label: ';', col: 23, row: 5},
    {code: 'Quote', label: "'", col: 25, row: 5},
    {code: 'Enter', label: 'Enter', col: 27, row: 5, width: 4},
    {code: 'Numpad4', label: '4', col: 38, row: 5, fullOnly: true},
    {code: 'Numpad5', label: '5', col: 40, row: 5, fullOnly: true},
    {code: 'Numpad6', label: '6', col: 42, row: 5, fullOnly: true},
    {code: 'ShiftLeft', label: 'Shift', col: 1, row: 6, width: 5},
    ...'ZXCVBNM'.split('').map((label, index) => ({
      code: `Key${label}`,
      label,
      col: 6 + index * 2,
      row: 6,
    })),
    {code: 'Comma', label: ',', col: 20, row: 6},
    {code: 'Period', label: '.', col: 22, row: 6},
    {code: 'Slash', label: '/', col: 24, row: 6},
    {code: 'ShiftRight', label: 'Shift', col: 26, row: 6, width: 5},
    {code: 'ArrowUp', label: '↑', col: 33.5, row: 6},
    {code: 'Numpad1', label: '1', col: 38, row: 6, fullOnly: true},
    {code: 'Numpad2', label: '2', col: 40, row: 6, fullOnly: true},
    {code: 'Numpad3', label: '3', col: 42, row: 6, fullOnly: true},
    {code: 'NumpadEnter', label: 'Enter', col: 44, row: 6, height: 2, fullOnly: true},
    {code: 'ControlLeft', label: 'Ctrl', col: 1, row: 7, width: 3},
    {code: 'MetaLeft', label: 'Win', col: 4, row: 7, width: 3},
    {code: 'AltLeft', label: 'Alt', col: 7, row: 7, width: 3},
    {code: 'Space', label: '', col: 10, row: 7, width: 11},
    {code: 'AltRight', label: 'RAlt', col: 21, row: 7, width: 3},
    {code: 'MetaRight', label: 'Win', col: 24, row: 7, width: 3},
    {code: 'ContextMenu', label: 'Menu', col: 27, row: 7, width: 2},
    {code: 'ControlRight', label: 'Ctrl', col: 29, row: 7, width: 2},
    {code: 'ArrowLeft', label: '←', col: 31.5, row: 7},
    {code: 'ArrowDown', label: '↓', col: 33.5, row: 7},
    {code: 'ArrowRight', label: '→', col: 35.5, row: 7},
    {code: 'Numpad0', label: '0', col: 38, row: 7, width: 4, fullOnly: true},
    {code: 'NumpadDecimal', label: '.', col: 42, row: 7, fullOnly: true},
  ],
  COMMON_LABELS,
);

const vanguard96Keys = withLabels(
  [
    compactKey('Escape', 0, 1),
    ...compactSeries(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'], 1, 1),
    compactKey('PrintScreen', 13, 1),
    compactKey('Delete', 14, 1),
    decorativeKey('VanguardDisplay', 'LCD', 15.25, 1, 2.75, 'display'),
    decorativeKey('VanguardDial', '●', 18.25, 1, 1, 'dial'),
    compactKey('Backquote', 0, 3),
    ...compactSeries(
      ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'],
      1,
      3,
    ),
    compactKey('Minus', 11, 3),
    compactKey('Equal', 12, 3),
    compactKey('Backspace', 13, 3, 2),
    compactKey('NumLock', 15.25, 3),
    compactKey('NumpadDivide', 16.25, 3),
    compactKey('NumpadMultiply', 17.25, 3),
    compactKey('NumpadSubtract', 18.25, 3),
    compactKey('Tab', 0, 4, 1.5),
    ...compactSeries(['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'], 1.5, 4),
    compactKey('BracketLeft', 11.5, 4),
    compactKey('BracketRight', 12.5, 4),
    compactKey('Backslash', 13.5, 4, 1.5),
    ...compactSeries(['Numpad7', 'Numpad8', 'Numpad9'], 15.25, 4),
    compactKey('NumpadAdd', 18.25, 4, 1, 2),
    compactKey('CapsLock', 0, 5, 1.75),
    ...compactSeries(['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'], 1.75, 5),
    compactKey('Semicolon', 10.75, 5),
    compactKey('Quote', 11.75, 5),
    compactKey('Enter', 12.75, 5, 2.25),
    ...compactSeries(['Numpad4', 'Numpad5', 'Numpad6'], 15.25, 5),
    compactKey('ShiftLeft', 0, 6, 2.25),
    ...compactSeries(['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM'], 2.25, 6),
    compactKey('Comma', 9.25, 6),
    compactKey('Period', 10.25, 6),
    compactKey('Slash', 11.25, 6),
    compactKey('ShiftRight', 12.25, 6, 1.75),
    compactKey('ArrowUp', 14.25, 6, 1, 1, {offsetX: -0.125}),
    ...compactSeries(['Numpad1', 'Numpad2', 'Numpad3'], 15.25, 6),
    compactKey('NumpadEnter', 18.25, 6, 1, 2),
    compactKey('ControlLeft', 0, 7, 1.25),
    compactKey('MetaLeft', 1.25, 7, 1.25),
    compactKey('AltLeft', 2.5, 7, 1.25),
    compactKey('Space', 3.75, 7, 6.25),
    compactKey('AltRight', 10, 7),
    compactKey('Fn', 11, 7),
    compactKey('ContextMenu', 12, 7),
    compactKey('ArrowLeft', 13.25, 7, 1, 1, {offsetX: -0.125}),
    compactKey('ArrowDown', 14.25, 7, 1, 1, {offsetX: -0.125}),
    compactKey('ArrowRight', 15.25, 7, 1, 1, {offsetX: -0.125}),
    compactKey('Numpad0', 16.25, 7),
    compactKey('NumpadDecimal', 17.25, 7),
  ],
  COMMON_LABELS,
);

const plum84Keys = withLabels(
  [
    compactKey('Escape', 0, 1),
    ...compactSeries(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'], 1, 1),
    compactKey('PrintScreen', 13, 1),
    compactKey('ScrollLock', 14, 1),
    compactKey('Delete', 15, 1),
    compactKey('Backquote', 0, 2),
    ...compactSeries(
      ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'],
      1,
      2,
    ),
    compactKey('Minus', 11, 2),
    compactKey('Equal', 12, 2),
    compactKey('Backspace', 13, 2, 2),
    compactKey('Home', 15, 2),
    compactKey('Tab', 0, 3, 1.5),
    ...compactSeries(['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'], 1.5, 3),
    compactKey('BracketLeft', 11.5, 3),
    compactKey('BracketRight', 12.5, 3),
    compactKey('Backslash', 13.5, 3, 1.5),
    compactKey('PageUp', 15, 3),
    compactKey('CapsLock', 0, 4, 1.75),
    ...compactSeries(['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'], 1.75, 4),
    compactKey('Semicolon', 10.75, 4),
    compactKey('Quote', 11.75, 4),
    compactKey('Enter', 12.75, 4, 2.25),
    compactKey('PageDown', 15, 4),
    compactKey('ShiftLeft', 0, 5, 2.25),
    ...compactSeries(['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM'], 2.25, 5),
    compactKey('Comma', 9.25, 5),
    compactKey('Period', 10.25, 5),
    compactKey('Slash', 11.25, 5),
    compactKey('ShiftRight', 12.25, 5, 1.75),
    compactKey('ArrowUp', 14, 5),
    compactKey('End', 15, 5),
    compactKey('ControlLeft', 0, 6, 1.25),
    compactKey('MetaLeft', 1.25, 6, 1.25),
    compactKey('AltLeft', 2.5, 6, 1.25),
    compactKey('Space', 3.75, 6, 6.25),
    compactKey('AltRight', 10, 6),
    compactKey('Fn', 11, 6),
    compactKey('ControlRight', 12, 6),
    compactKey('ArrowLeft', 13, 6),
    compactKey('ArrowDown', 14, 6),
    compactKey('ArrowRight', 15, 6),
  ],
  COMMON_LABELS,
);

const kemove68Keys = withLabels(
  [
    compactKey('Escape', 0, 1),
    ...compactSeries(
      ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0'],
      1,
      1,
    ),
    compactKey('Minus', 11, 1),
    compactKey('Equal', 12, 1),
    compactKey('Backspace', 13, 1, 2),
    compactKey('Home', 15, 1),
    compactKey('Tab', 0, 2, 1.5),
    ...compactSeries(['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'], 1.5, 2),
    compactKey('BracketLeft', 11.5, 2),
    compactKey('BracketRight', 12.5, 2),
    compactKey('Backslash', 13.5, 2, 1.5),
    compactKey('PageUp', 15, 2),
    compactKey('CapsLock', 0, 3, 1.75),
    ...compactSeries(['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'], 1.75, 3),
    compactKey('Semicolon', 10.75, 3),
    compactKey('Quote', 11.75, 3),
    compactKey('Enter', 12.75, 3, 2.25),
    compactKey('PageDown', 15, 3),
    compactKey('ShiftLeft', 0, 4, 2.25),
    ...compactSeries(['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM'], 2.25, 4),
    compactKey('Comma', 9.25, 4),
    compactKey('Period', 10.25, 4),
    compactKey('Slash', 11.25, 4),
    compactKey('ShiftRight', 12.25, 4, 1.75),
    compactKey('ArrowUp', 14, 4),
    compactKey('Delete', 15, 4),
    compactKey('ControlLeft', 0, 5, 1.25),
    compactKey('MetaLeft', 1.25, 5, 1.25),
    compactKey('AltLeft', 2.5, 5, 1.25),
    compactKey('Space', 3.75, 5, 6.25),
    compactKey('AltRight', 10, 5),
    compactKey('Fn', 11, 5),
    compactKey('ControlRight', 12, 5),
    compactKey('ArrowLeft', 13, 5),
    compactKey('ArrowDown', 14, 5),
    compactKey('ArrowRight', 15, 5),
  ],
  COMMON_LABELS,
);

function convert(keys: HandoffKey[], yOfRow: (row: number) => number): StoredGeometryKey[] {
  return keys.map((key) => storedFromHandoff(key, yOfRow(key.row)));
}

export const DEFAULT_KEYBOARD_GEOMETRIES: GeometrySeed[] = [
  {
    slug: 'full-108',
    name: '108-key full size',
    formFactor: 'full',
    keys: convert(fullKeys, (row) => yWithGap(row, FULL_GAP)),
  },
  {
    slug: 'tkl-80',
    name: '80% tenkeyless',
    formFactor: 'tkl',
    keys: convert(
      fullKeys.filter((key) => !key.fullOnly),
      (row) => yWithGap(row, FULL_GAP),
    ),
  },
  {
    slug: 'corsair-vanguard-pro-96',
    name: 'Corsair Vanguard Pro 96',
    formFactor: '96',
    keys: convert(vanguard96Keys, (row) => yWithGap(row, NINETY_SIX_GAP)),
  },
  {
    slug: 'niz-plum-84',
    name: 'NiZ Plum 84',
    formFactor: '75',
    keys: convert(plum84Keys, (row) => row - 1),
  },
  {
    slug: 'kemove-k68',
    name: 'KEMOVE K68',
    formFactor: '65',
    keys: convert(kemove68Keys, (row) => row - 1),
  },
];

export const DEFAULT_KEYBOARD_PRODUCTS = [
  {slugGeometry: 'corsair-vanguard-pro-96', brand: 'Corsair', model: 'Vanguard Pro 96'},
  {slugGeometry: 'niz-plum-84', brand: 'NiZ', model: 'Plum 84'},
  {slugGeometry: 'kemove-k68', brand: 'KEMOVE', model: 'K68'},
];

export const DEFAULT_KEYBOARD_SWITCHES = [
  {name: 'Cherry MX Red', sensing: 'mechanical' as const},
  {name: 'Cherry MX Brown', sensing: 'mechanical' as const},
  {name: 'Gateron Yellow', sensing: 'mechanical' as const},
  {name: 'Gateron Magnetic Jade', sensing: 'hall' as const},
  {name: 'Wooting Lekker', sensing: 'hall' as const},
  {name: 'Kailh Box White', sensing: 'mechanical' as const},
  {name: 'Gateron Optical Red', sensing: 'optical' as const},
];
