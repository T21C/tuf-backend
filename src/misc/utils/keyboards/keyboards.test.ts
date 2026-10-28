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
  layoutSetupRecord,
  promoteSharedBoardDefaults,
  assertBoardSpecFitsGeometry,
  parseSwitchSensing,
  parseKeybindText,
  parseStoredGeometryKeys,
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

test('board spec stores optional stem, base, and top housing colors', () => {
  const parsed = parseBoardSpecInput({
    geometryId: 1,
    sensing: 'mechanical',
    stemColor: '#E23B3B',
    baseColor: '#1A1A1A',
    topColor: '#334455',
    baseOpacity: 0.4,
  });
  assert.equal(parsed.stemColor, '#e23b3b');
  assert.equal(parsed.baseColor, '#1a1a1a');
  assert.equal(parsed.topColor, '#334455');
  assert.equal(parsed.baseOpacity, 0.4);
  assert.equal(parsed.productId, null);
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

test('membrane sensing strips switch-modifiable board fields', () => {
  const switchField = BOARD_SPEC_FIELDS.find((field) => field.id === 'switch');
  const actuation = BOARD_SPEC_FIELDS.find((field) => field.id === 'actuationMm');
  assert.ok(switchField && actuation);
  assert.equal(specFieldVisible(switchField, {sensing: 'mechanical'}), true);
  assert.equal(specFieldVisible(actuation, {sensing: 'hall'}), true);
  assert.equal(specFieldVisible(switchField, {sensing: 'membrane'}), false);
  assert.equal(specFieldVisible(actuation, {sensing: 'membrane'}), false);
  const parsed = parseBoardSpecInput({
    geometryId: 1,
    sensing: 'membrane',
    switchId: 4,
    customSwitch: 'foam dome',
    actuationMm: 2,
    stemColor: '#e23b3b',
    baseColor: '#1a1a1a',
    topColor: '#334455',
    baseOpacity: 0.4,
    rapidTriggerSplit: true,
    rapidTriggerActuationMm: 1.2,
    rapidTriggerPressMm: 0.4,
    rapidTriggerReleaseMm: 0.2,
    keyOverrides: [{code: 'KeyA', socketEmpty: true}],
  });
  assert.equal(parsed.sensing, 'membrane');
  assert.equal(parsed.switchId, null);
  assert.equal(parsed.customSwitch, null);
  assert.equal(parsed.actuationMm, null);
  assert.equal(parsed.stemColor, null);
  assert.equal(parsed.baseColor, null);
  assert.equal(parsed.topColor, null);
  assert.equal(parsed.baseOpacity, null);
  assert.equal(parsed.rapidTriggerSplit, false);
  assert.equal(parsed.rapidTriggerActuationMm, null);
  assert.deepEqual(parsed.keyOverrides, []);
  assert.deepEqual(parsed.switches, []);
  assert.throws(() => parseSwitchSensing('membrane'), KeyboardSetupError);
});

test('a pulled switch clears that key’s switch index', () => {
  const parsed = parseBoardSpecInput({
    geometryId: 1,
    sensing: 'mechanical',
    switches: [{switchId: 4}],
    keyOverrides: [{code: 'KeyQ', switchAbsent: true, periodSwitchIndex: 0}],
  });
  assert.equal(parsed.keyOverrides?.[0].switchAbsent, true);
  assert.equal(parsed.keyOverrides?.[0].periodSwitchIndex, null);
  assert.equal(layoutSetupRecord(parsed).keyOverrides[0].switchAbsent, true);
});

test('an absent switch drops catalog identity and colors', () => {
  const parsed = parseBoardSpecInput({
    geometryId: 1,
    sensing: 'mechanical',
    switches: [{absent: true, switchId: 4, customSwitch: 'pulled', stemColor: '#ffffff'}],
  });
  assert.equal(parsed.switches?.[0].absent, true);
  assert.equal(parsed.switches?.[0].switchId, null);
  assert.equal(parsed.switches?.[0].customSwitch, null);
  assert.equal(parsed.switches?.[0].stemColor, null);
  assert.equal(layoutSetupRecord(parsed).switches[0].absent, true);
});

test('board switch list and per-key actuation round-trip through parse', () => {
  const parsed = parseBoardSpecInput({
    geometryId: 1,
    sensing: 'hall',
    switches: [
      {id: 9, switchId: 4, customSwitch: 'alpha', stemColor: '#E23B3B', baseOpacity: 0.5},
      {customSwitch: 'beta', stemColor: '#2f6fdb'},
    ],
    keyOverrides: [
      {
        code: 'KeyA',
        periodSwitchId: 9,
        actuationMm: 1.25,
        rapidTriggerSplit: false,
        rapidTriggerActuationMm: 0.4,
      },
      {
        code: 'KeyS',
        periodSwitchIndex: 1,
        actuationMm: 2,
        rapidTriggerPressMm: 0.3,
        rapidTriggerReleaseMm: 0.2,
      },
    ],
  });
  assert.equal(parsed.switches?.length, 2);
  assert.equal(parsed.switches?.[0].stemColor, '#e23b3b');
  assert.equal(parsed.switches?.[0].baseOpacity, 0.5);
  assert.equal(parsed.keyOverrides?.[0].periodSwitchIndex, 0);
  assert.equal(parsed.keyOverrides?.[0].actuationMm, 1.25);
  assert.equal(parsed.keyOverrides?.[0].rapidTriggerSplit, false);
  assert.equal(parsed.keyOverrides?.[0].rapidTriggerActuationMm, 0.4);
  assert.equal(parsed.keyOverrides?.[1].periodSwitchIndex, 1);
  assert.equal(parsed.keyOverrides?.[1].rapidTriggerSplit, true);
  assert.equal(parsed.keyOverrides?.[1].rapidTriggerActuationMm, null);
  assert.equal(parsed.keyOverrides?.[1].rapidTriggerPressMm, 0.3);
});

test('non-hall sensing strips per-key rapid trigger', () => {
  const parsed = parseBoardSpecInput({
    geometryId: 1,
    sensing: 'mechanical',
    keyOverrides: [
      {
        code: 'KeyA',
        rapidTriggerSplit: true,
        rapidTriggerPressMm: 0.4,
        rapidTriggerReleaseMm: 0.2,
        actuationMm: 1.5,
      },
    ],
  });
  assert.equal(parsed.keyOverrides?.[0].actuationMm, 1.5);
  assert.equal(parsed.keyOverrides?.[0].rapidTriggerSplit, null);
  assert.equal(parsed.keyOverrides?.[0].rapidTriggerPressMm, null);
});

test('shared per-key actuation copies up to the board', () => {
  const promoted = promoteSharedBoardDefaults(
    parseBoardSpecInput({
      geometryId: 1,
      sensing: 'hall',
      actuationMm: 2,
      rapidTriggerActuationMm: 1,
      switches: [
        {customSwitch: 'left', stemColor: '#e23b3b'},
        {customSwitch: 'right', stemColor: '#2f6fdb'},
      ],
      keyOverrides: [
        {
          code: 'KeyA',
          periodSwitchIndex: 1,
          actuationMm: 1.5,
          rapidTriggerSplit: false,
          rapidTriggerActuationMm: 0.4,
        },
        {
          code: 'KeyS',
          periodSwitchIndex: 1,
          actuationMm: 1.5,
          rapidTriggerActuationMm: 0.4,
        },
      ],
    }),
    ['KeyA', 'KeyS'],
  );
  assert.equal(promoted.actuationMm, 1.5);
  assert.equal(promoted.rapidTriggerSplit, false);
  assert.equal(promoted.rapidTriggerActuationMm, 0.4);
  assert.equal(promoted.customSwitch, 'right');
  assert.equal(promoted.stemColor, '#2f6fdb');
});

test('mixed per-key depths leave board defaults in place', () => {
  const promoted = promoteSharedBoardDefaults(
    parseBoardSpecInput({
      geometryId: 1,
      sensing: 'mechanical',
      actuationMm: 2,
      customSwitch: 'stock',
      switches: [{customSwitch: 'left'}, {customSwitch: 'right'}],
      keyOverrides: [
        {code: 'KeyA', periodSwitchIndex: 0, actuationMm: 1},
        {code: 'KeyS', periodSwitchIndex: 1, actuationMm: 2},
      ],
    }),
    ['KeyA', 'KeyS'],
  );
  assert.equal(promoted.actuationMm, 2);
  assert.equal(promoted.customSwitch, 'stock');
});

test('switch list longer than 64 is rejected', () => {
  assert.throws(
    () =>
      parseBoardSpecInput({
        geometryId: 1,
        switches: Array.from({length: 65}, () => ({customSwitch: 'x'})),
      }),
    KeyboardSetupError,
  );
});

test('unknown key override codes are rejected against geometry', () => {
  assert.throws(
    () =>
      assertBoardSpecFitsGeometry(
        parseBoardSpecInput({
          geometryId: 1,
          keyOverrides: [{code: 'Nope', actuationMm: 1}],
        }),
        ['KeyA'],
        ['KeyA'],
      ),
    KeyboardSetupError,
  );
});

test('switch list longer than bindable keys is rejected', () => {
  assert.throws(
    () =>
      assertBoardSpecFitsGeometry(
        parseBoardSpecInput({
          geometryId: 1,
          switches: [{customSwitch: 'a'}, {customSwitch: 'b'}, {customSwitch: 'c'}],
        }),
        ['KeyA', 'KeyS'],
        ['KeyA'],
      ),
    KeyboardSetupError,
  );
});

test('import snapshot board fields keep version 1 with per-key data', () => {
  const parsed = parseBoardSpecInput({
    geometryId: 1,
    sensing: 'hall',
    switches: [{customSwitch: 'left', stemColor: '#e23b3b'}],
    keyOverrides: [{code: 'KeyA', periodSwitchIndex: 0, actuationMm: 1.25}],
  });
  assert.equal(parsed.switches?.[0].customSwitch, 'left');
  assert.equal(parsed.keyOverrides?.[0].actuationMm, 1.25);
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

test('KLE split spacebar keeps both keys on Space', () => {
  const keys = importKleRaw([
    [
      {w: 1.25}, 'Ctrl',
      {w: 1.25}, 'Win',
      {w: 1.25}, 'Alt',
      {w: 2.25}, '',
      {w: 2.75}, '',
      {w: 1.25}, 'Alt',
      {w: 1.25}, 'Fn',
      {w: 1.25}, 'Ctrl',
    ],
  ]);
  const spaces = keys.filter((key) => key.code === 'Space');
  assert.equal(spaces.length, 2);
  assert.deepEqual(spaces.map((key) => key.bindable), [true, true]);
  assert.deepEqual(spaces.map((key) => key.w), [2.25, 2.75]);
  assert.equal(parseStoredGeometryKeys(keys).filter((key) => key.code === 'Space').length, 2);
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
