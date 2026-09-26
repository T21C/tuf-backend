import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalizeKeys,
  currentPeriod,
  findPeriodAt,
  formatKeybind,
  importKleRaw,
  keySignature,
  matchRankerToPlayer,
  parseBoardSpecInput,
  parseKeybindText,
  parseSinceDate,
  playerHasKeyboardsModule,
  specFieldVisible,
  BOARD_SPEC_FIELDS,
  KeyboardSetupError,
  assertUniqueSinceDates,
  assertRangeGroup,
  effectiveUntil,
  DEFAULT_KEYBOARD_GEOMETRIES,
} from './index.js';

test('canonical key signatures match the handoff separator', () => {
  const keys = canonicalizeKeys(['Space', 'KeyV', 'ControlLeft', 'KeyV']);
  assert.deepEqual(keys, ['KeyV', 'ControlLeft', 'Space']);
  assert.equal(keySignature(keys), 'KeyV\u001fControlLeft\u001fSpace');
});

test('parseKeybindText accepts aliases and reports unknowns', () => {
  const parsed = parseKeybindText('LCtrl V spacebar nope V');
  assert.deepEqual(parsed.keys, ['KeyV', 'ControlLeft', 'Space']);
  assert.deepEqual(parsed.unknownTokens, ['nope']);
  assert.deepEqual(parsed.duplicateTokens, ['V']);
  assert.equal(formatKeybind(parsed.keys), 'V LCtrl Space');
});

test('duplicate since dates on one list are rejected', () => {
  assert.throws(
    () =>
      assertUniqueSinceDates([
        {sinceDate: '2025-09-12'},
        {sinceDate: '2025-09-12'},
      ]),
    KeyboardSetupError,
  );
  assert.throws(
    () =>
      assertUniqueSinceDates([
        {sinceDate: null},
        {sinceDate: null},
      ]),
    KeyboardSetupError,
  );
  assertUniqueSinceDates([{sinceDate: null}, {sinceDate: '2025-09-12'}]);
});

test('since dates are unique UTC days and unknown is earliest only', () => {
  assert.equal(parseSinceDate('2025-09-12'), '2025-09-12');
  assert.equal(parseSinceDate(null), null);
  assert.throws(() => parseSinceDate('2025-13-01'), KeyboardSetupError);
  const current = currentPeriod([
    {id: 2, sinceDate: '2025-09-12'},
    {id: 1, sinceDate: null},
  ]);
  assert.equal(current?.id, 2);
  assert.equal(
    findPeriodAt(
      [
        {id: 1, sinceDate: null},
        {id: 2, sinceDate: '2025-09-12'},
      ],
      '2025-09-11',
    )?.id,
    1,
  );
  assert.equal(
    findPeriodAt(
      [
        {id: 1, sinceDate: null},
        {id: 2, sinceDate: '2025-09-12'},
      ],
      '2025-09-12',
    )?.id,
    2,
  );
});

test('auto until stretches to the next fitting start', () => {
  const eightA = {id: 1, sinceDate: '2020-01-01'};
  const sixteen = {id: 2, sinceDate: '2021-01-01'};
  const eightB = {id: 3, sinceDate: '2022-01-01'};
  const eights = [eightA, eightB];
  assert.equal(effectiveUntil(eightA, eights), '2022-01-01');
  assert.equal(effectiveUntil(eightA, [eightA, sixteen, eightB]), '2021-01-01');
  assert.equal(
    findPeriodAt([eightA], '2021-06-01', eights)?.id,
    1,
  );
  assert.equal(findPeriodAt(eights, '2022-01-01')?.id, 3);
});

test('manual until is exclusive and overlapping ranges are rejected', () => {
  const closed = {id: 1, sinceDate: '2020-01-01', untilDate: '2022-01-01', untilAuto: false};
  const next = {id: 2, sinceDate: '2022-01-01'};
  assert.equal(findPeriodAt([closed, next], '2021-12-31')?.id, 1);
  assert.equal(findPeriodAt([closed, next], '2022-01-01')?.id, 2);
  assertRangeGroup([closed, next]);
  assert.throws(
    () =>
      assertRangeGroup([
        {id: 1, sinceDate: '2020-01-01', untilDate: '2023-01-01', untilAuto: false},
        {id: 2, sinceDate: '2022-01-01'},
      ]),
    KeyboardSetupError,
  );
});

test('rapid trigger actuation is hall-only', () => {
  const rt = BOARD_SPEC_FIELDS.find((field) => field.id === 'rapidTriggerActuationMm');
  const press = BOARD_SPEC_FIELDS.find((field) => field.id === 'rapidTriggerPressMm');
  const release = BOARD_SPEC_FIELDS.find((field) => field.id === 'rapidTriggerReleaseMm');
  assert.ok(rt && press && release);
  assert.equal(specFieldVisible(rt, {sensing: 'mechanical'}), false);
  assert.equal(specFieldVisible(rt, {sensing: 'hall'}), true);
  assert.equal(specFieldVisible(rt, {sensing: 'hall', rapidTriggerSplit: true}), false);
  assert.equal(specFieldVisible(press, {sensing: 'hall', rapidTriggerSplit: true}), true);
  assert.equal(specFieldVisible(release, {sensing: 'hall'}), false);
  const parsed = parseBoardSpecInput({
    geometryId: 1,
    sensing: 'mechanical',
    rapidTriggerActuationMm: 1.2,
    rapidTriggerPressMm: 0.4,
    rapidTriggerReleaseMm: 0.2,
    actuationMm: 2,
  });
  assert.equal(parsed.rapidTriggerActuationMm, null);
  assert.equal(parsed.rapidTriggerPressMm, null);
  assert.equal(parsed.rapidTriggerReleaseMm, null);
  assert.equal(parsed.actuationMm, 2);
  const split = parseBoardSpecInput({
    geometryId: 1,
    sensing: 'hall',
    rapidTriggerSplit: true,
    rapidTriggerActuationMm: 1.2,
    rapidTriggerPressMm: 0.4,
    rapidTriggerReleaseMm: 0.2,
  });
  assert.equal(split.rapidTriggerSplit, true);
  assert.equal(split.rapidTriggerActuationMm, null);
  assert.equal(split.rapidTriggerPressMm, 0.4);
  assert.equal(split.rapidTriggerReleaseMm, 0.2);
});

test('KLE import maps known legends to HID codes', () => {
  const keys = importKleRaw([['Esc', {w: 2}, 'Backspace'], ['A', 'B']]);
  assert.equal(keys[0].code, 'Escape');
  assert.equal(keys[1].code, 'Backspace');
  assert.equal(keys[1].w, 2);
  assert.equal(keys[2].code, 'KeyA');
  assert.equal(keys[2].y, 1);
});

test('KLE y offset shifts every following row', () => {
  const keys = importKleRaw([['Esc'], [{y: 0.5}, '1'], ['Q'], ['A']]);
  assert.equal(keys[0].y, 0);
  assert.equal(keys[1].y, 1.5);
  assert.equal(keys[2].y, 2.5);
  assert.equal(keys[3].y, 3.5);
});

test('KLE empty legend is the spacebar', () => {
  const keys = importKleRaw([[{w: 6.25}, '']]);
  assert.equal(keys[0].code, 'Space');
  assert.equal(keys[0].bindable, true);
  assert.equal(keys[0].w, 6.25);
  assert.equal(keys[0].label.trim(), '');
});

test('KLE multi-line legends keep both symbols and distinct numpad codes', () => {
  const keys = importKleRaw([
    ['Esc', {x: 1}, 'F1', 'F2', 'F3', 'F4', {x: 0.5}, 'F5', 'F6', 'F7', 'F8', {x: 0.5}, 'F9', 'F10', 'F11', 'F12', {x: 0.25}, 'PrtSc', 'Scroll Lock', 'Pause\nBreak'],
    [{y: 0.5}, '~\n`', '!\n1', '@\n2', '#\n3', '$\n4', '%\n5', '^\n6', '&\n7', '*\n8', '(\n9', ')\n0', '_\n-', '+\n=', {w: 2}, 'Backspace', {x: 0.25}, 'Insert', 'Home', 'PgUp', {x: 0.25}, 'Num Lock', '/', '*', '-'],
    [{w: 1.5}, 'Tab', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '{\n[', '}\n]', {w: 1.5}, '|\n\\', {x: 0.25}, 'Delete', 'End', 'PgDn', {x: 0.25}, '7\nHome', '8\n↑', '9\nPgUp', {h: 2}, '+'],
    [{w: 1.75}, 'Caps Lock', 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ':\n;', '"\n\'', {w: 2.25}, 'Enter', {x: 3.5}, '4\n←', '5', '6\n→'],
    [{w: 2.25}, 'Shift', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', '<\n,', '>\n.', '?\n/', {w: 2.75}, 'Shift', {x: 1.25}, '↑', {x: 1.25}, '1\nEnd', '2\n↓', '3\nPgDn', {h: 2}, 'Enter'],
    [{w: 1.25}, 'Ctrl', {w: 1.25}, 'Win', {w: 1.25}, 'Alt', {a: 0, w: 6.25}, '', {a: 4, w: 1.25}, 'Alt', {w: 1.25}, 'Win', {w: 1.25}, 'Menu', {w: 1.25}, 'Ctrl', {x: 0.25}, '←', '↓', '→', {x: 0.25, w: 2}, '0\nIns', '.\nDel'],
  ]);
  assert.deepEqual(keys.map((key) => key.code), [
    'Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'PrintScreen', 'ScrollLock', 'Pause',
    'Backquote', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal', 'Backspace', 'Insert', 'Home', 'PageUp', 'NumLock', 'NumpadDivide', 'NumpadMultiply', 'NumpadSubtract',
    'Tab', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight', 'Backslash', 'Delete', 'End', 'PageDown', 'Numpad7', 'Numpad8', 'Numpad9', 'NumpadAdd',
    'CapsLock', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote', 'Enter', 'Numpad4', 'Numpad5', 'Numpad6',
    'ShiftLeft', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash', 'ShiftRight', 'ArrowUp', 'Numpad1', 'Numpad2', 'Numpad3', 'NumpadEnter',
    'ControlLeft', 'MetaLeft', 'AltLeft', 'Space', 'AltRight', 'MetaRight', 'ContextMenu', 'ControlRight', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'Numpad0', 'NumpadDecimal',
  ]);
  assert.equal(keys.find((key) => key.code === 'Digit1')?.label, '!\n1');
  assert.equal(keys.find((key) => key.code === 'Numpad7')?.label, '7\nHome');
  assert.equal(keys.find((key) => key.code === 'Pause')?.label, 'Pause\nBreak');
  assert.equal(keys.find((key) => key.code === 'Numpad8')?.label, '8\n↑');
  assert.equal(keys.every((key) => key.bindable), true);
  assert.equal(keys.find((key) => key.code === 'Backquote')?.y, 1.5);
  assert.equal(keys.find((key) => key.code === 'NumpadAdd')?.h, 2);
});

test('ranker names match a unique player and skip collisions', () => {
  const players = [
    {id: 1, name: 'Jipper', aliases: ['지퍼']},
    {id: 2, name: 'Other', aliases: ['지퍼']},
  ];
  const unique = matchRankerToPlayer(['asjdh'], [{id: 3, name: 'asjdh', aliases: ['아스제']}]);
  assert.deepEqual(unique, {playerId: 3});
  const miss = matchRankerToPlayer(['nobody'], players);
  assert.equal('status' in miss && miss.status, 'none');
  const clash = matchRankerToPlayer(['지퍼'], players);
  assert.equal('status' in clash && clash.status, 'ambiguous');
});

test('keyboards module visibility reads stored payload', () => {
  assert.equal(playerHasKeyboardsModule(null), false);
  assert.equal(
    playerHasKeyboardsModule({
      version: 1,
      modules: [{id: 'kb-1', type: 'keyboards', config: {}}],
    }),
    true,
  );
});

test('five staff geometries ship with form-factor buckets', () => {
  assert.equal(DEFAULT_KEYBOARD_GEOMETRIES.length, 5);
  assert.deepEqual(
    DEFAULT_KEYBOARD_GEOMETRIES.map((row) => [row.slug, row.formFactor]),
    [
      ['full-108', 'full'],
      ['tkl-80', 'tkl'],
      ['corsair-vanguard-pro-96', '96'],
      ['niz-plum-84', '75'],
      ['kemove-k68', '65'],
    ],
  );
});
