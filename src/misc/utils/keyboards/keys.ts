import {KEY_SIGNATURE_SEPARATOR, KeyboardSetupError} from './types.js';

export const KEY_ORDER = [
  'Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'PrintScreen', 'ScrollLock', 'Pause',
  'AudioVolumeMute', 'AudioVolumeDown', 'AudioVolumeUp', 'Calculator',
  'Backquote', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
  'Minus', 'Equal', 'Backspace', 'Insert', 'Home', 'PageUp',
  'NumLock', 'NumpadDivide', 'NumpadMultiply', 'NumpadSubtract',
  'Tab', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP',
  'BracketLeft', 'BracketRight', 'Backslash', 'Delete', 'End', 'PageDown',
  'Numpad7', 'Numpad8', 'Numpad9', 'NumpadAdd',
  'CapsLock', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL',
  'Semicolon', 'Quote', 'Enter', 'Numpad4', 'Numpad5', 'Numpad6',
  'ShiftLeft', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM',
  'Comma', 'Period', 'Slash', 'ShiftRight', 'ArrowUp',
  'Numpad1', 'Numpad2', 'Numpad3', 'NumpadEnter',
  'ControlLeft', 'MetaLeft', 'AltLeft', 'Space', 'AltRight', 'MetaRight', 'ContextMenu', 'Fn', 'ControlRight',
  'ArrowLeft', 'ArrowDown', 'ArrowRight',
  'Numpad0', 'NumpadDecimal',
  'IntlBackslash', 'Lang1', 'Lang2',
] as const;

const keyboardOrder = new Map(KEY_ORDER.map((code, index) => [code, index]));

const preferredTokens: Record<string, string> = {
  Escape: 'Esc',
  PrintScreen: 'PrintScreen',
  ScrollLock: 'ScrollLock',
  AudioVolumeMute: 'Mute',
  AudioVolumeDown: 'Vol-',
  AudioVolumeUp: 'Vol+',
  Calculator: 'Calc',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  ShiftLeft: 'LShift',
  ShiftRight: 'RShift',
  ControlLeft: 'LCtrl',
  ControlRight: 'RCtrl',
  MetaLeft: 'LWin',
  MetaRight: 'RWin',
  AltLeft: 'LAlt',
  AltRight: 'RAlt',
  ContextMenu: 'Menu',
  ArrowLeft: 'Left',
  ArrowDown: 'Down',
  ArrowUp: 'Up',
  ArrowRight: 'Right',
  NumpadDivide: 'Num/',
  NumpadMultiply: 'Num*',
  NumpadSubtract: 'Num-',
  NumpadAdd: 'Num+',
  NumpadEnter: 'NumEnter',
  NumpadDecimal: 'Num.',
};

export function tokenForKey(code: string): string {
  if (preferredTokens[code]) return preferredTokens[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num${code.slice(6)}`;
  return code;
}

const aliases = new Map<string, string>();
const normalize = (token: string) => token.trim().toLocaleLowerCase();
const addAliases = (code: string, values: string[]) => {
  for (const value of values) aliases.set(normalize(value), code);
};

for (const code of KEY_ORDER) {
  addAliases(code, [code, tokenForKey(code)]);
}

addAliases('Escape', ['escape']);
addAliases('Backquote', ['backquote', 'backtick', 'grave', 'tilde']);
addAliases('Backslash', ['backslash', 'won', '₩']);
addAliases('CapsLock', ['caps', 'capslock']);
addAliases('Enter', ['return', 'return(=enter)']);
addAliases('Space', ['spacebar']);
addAliases('PrintScreen', ['prtsc', 'prtscr', 'print', 'printscreen']);
addAliases('ScrollLock', ['scrlock', 'scrlk', 'scroll', 'scrolllock']);
addAliases('Pause', ['break', 'pausebreak']);
addAliases('Insert', ['ins']);
addAliases('Delete', ['del']);
addAliases('PageUp', ['pageup', 'pgup']);
addAliases('PageDown', ['pagedown', 'pgdn', 'pgdown']);
addAliases('NumLock', ['numlk', 'numlck', 'nmlk']);
addAliases('ControlLeft', ['leftctrl', 'leftcontrol', 'ctrlleft', 'lcontrol']);
addAliases('ControlRight', ['rightctrl', 'rightcontrol', 'ctrlright', 'rcontrol']);
addAliases('ShiftLeft', ['leftshift', 'shiftleft']);
addAliases('ShiftRight', ['rightshift', 'shiftright']);
addAliases('AltLeft', ['leftalt', 'altleft']);
addAliases('AltRight', ['rightalt', 'altright', 'altgr']);
addAliases('MetaLeft', ['leftwin', 'winleft', 'metaleft']);
addAliases('MetaRight', ['rightwin', 'winright', 'metaright']);
addAliases('ContextMenu', ['contextmenu', 'apps', 'app']);
addAliases('ArrowLeft', ['arrowleft', 'leftarrow', '←']);
addAliases('ArrowDown', ['arrowdown', 'downarrow', '↓']);
addAliases('ArrowUp', ['arrowup', 'uparrow', '↑']);
addAliases('ArrowRight', ['arrowright', 'rightarrow', '→']);
addAliases('IntlBackslash', ['intlbackslash', 'nubs', 'iso\\']);
addAliases('Fn', ['fn']);

for (let digit = 0; digit <= 9; digit += 1) {
  addAliases(`Numpad${digit}`, [`numpad${digit}`, `num${digit}`, `kp${digit}`]);
}

addAliases('NumpadDivide', ['numpad/', 'numpaddivide', 'numdivide', 'kp/']);
addAliases('NumpadMultiply', ['numpad*', 'numpadmultiply', 'nummultiply', 'kp*']);
addAliases('NumpadSubtract', ['numpad-', 'numpadsubtract', 'numsubtract', 'kp-']);
addAliases('NumpadAdd', ['numpad+', 'numpadadd', 'numadd', 'kp+']);
addAliases('NumpadEnter', ['numpadenter', 'kpenter']);
addAliases('NumpadDecimal', ['numpad.', 'numpaddecimal', 'numdecimal', 'kp.']);

export function resolveKeyAlias(token: string): string | null {
  return aliases.get(normalize(token)) ?? null;
}

export function canonicalizeKeys(keys: string[]): string[] {
  return [...new Set(keys)].sort(
    (left, right) =>
      (keyboardOrder.get(left as (typeof KEY_ORDER)[number]) ?? Number.MAX_SAFE_INTEGER) -
      (keyboardOrder.get(right as (typeof KEY_ORDER)[number]) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function keySignature(keys: string[]): string {
  return canonicalizeKeys(keys).join(KEY_SIGNATURE_SEPARATOR);
}

export function sameKeySet(left: string[], right: string[]): boolean {
  return keySignature(left) === keySignature(right);
}

export type ParsedKeybind = {
  keys: string[];
  unknownTokens: string[];
  duplicateTokens: string[];
};

export function parseKeybindText(value: string): ParsedKeybind {
  const tokens = value.split(/[\s,]+/).filter(Boolean);
  const keys: string[] = [];
  const unknownTokens: string[] = [];
  const duplicateTokens: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const code = resolveKeyAlias(token);
    if (!code) {
      unknownTokens.push(token);
      continue;
    }
    if (seen.has(code)) {
      duplicateTokens.push(token);
      continue;
    }
    seen.add(code);
    keys.push(code);
  }

  return {keys: canonicalizeKeys(keys), unknownTokens, duplicateTokens};
}

export function formatKeybind(keys: string[]): string {
  return canonicalizeKeys(keys).map(tokenForKey).join(' ');
}

export function parseKeysArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new KeyboardSetupError(400, 'keys must be an array of key codes');
  }
  const keys: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new KeyboardSetupError(400, 'Each key must be a non-empty string');
    }
    const code = resolveKeyAlias(item) ?? item.trim();
    keys.push(code);
  }
  return canonicalizeKeys(keys);
}
