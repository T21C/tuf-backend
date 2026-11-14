import assert from 'node:assert/strict';
import test from 'node:test';
import {curationTypeEmojiMarkup} from './curationTypeEmojis.js';
import {
  curationThreadRequestedTokens,
  curationTypeMarkResolver,
  formatCurationThreadHeadline,
  formatCurationThreadMarks,
  joinCurationThreadTokens,
} from './curationThread.js';

test('curationThreadRequestedTokens copies a letter prefix across a range', () => {
  assert.deepEqual(curationThreadRequestedTokens('C0-1'), ['C0', '-', 'C1']);
  assert.deepEqual(curationThreadRequestedTokens('C0~1'), ['C0', '~', 'C1']);
  assert.deepEqual(curationThreadRequestedTokens('vote C0-1'), ['C0', '-', 'C1']);
  assert.deepEqual(curationThreadRequestedTokens('  Vote   C2 '), ['C2']);
});

test('curationThreadRequestedTokens keeps several types and misc names', () => {
  assert.deepEqual(curationThreadRequestedTokens('C1 V2 Epic'), ['C1', 'V2', 'Epic']);
  assert.deepEqual(curationThreadRequestedTokens('C0-1 V2'), ['C0', '-', 'C1', 'V2']);
  assert.deepEqual(curationThreadRequestedTokens(''), []);
  assert.deepEqual(curationThreadRequestedTokens('vote'), []);
});

test('joinCurationThreadTokens glues ranges and spaces other types', () => {
  assert.equal(joinCurationThreadTokens(['C0', '-', 'C1']), 'C0-C1');
  assert.equal(joinCurationThreadTokens(['C1', 'V2', 'Epic']), 'C1 V2 Epic');
  assert.equal(joinCurationThreadTokens(['C0', '-', 'C1', 'V2']), 'C0-C1 V2');
});

test('formatCurationThreadMarks resolves emojis for a C0-1 range', () => {
  const byName = new Map([
    ['c0', 'C0'],
    ['c1', 'C1'],
    ['v2', 'V2'],
  ]);
  const {resolveName, resolveEmoji} = curationTypeMarkResolver(byName);
  const marks = formatCurationThreadMarks(
    curationThreadRequestedTokens('C0-1'),
    resolveName,
    resolveEmoji,
  );
  assert.equal(marks.names, 'C0-C1');
  assert.equal(
    marks.emojis,
    `${curationTypeEmojiMarkup('C0')}-${curationTypeEmojiMarkup('C1')}`,
  );
});

test('formatCurationThreadHeadline matches the rating opener shape', () => {
  assert.equal(
    formatCurationThreadHeadline('C1 V2', 'Song (Charter)', 'C2'),
    'C1 V2 Song (Charter) ➔ C2',
  );
  assert.equal(
    formatCurationThreadHeadline('', 'Song (Charter)', 'C0-C1'),
    'Song (Charter) ➔ C0-C1',
  );
  assert.equal(
    formatCurationThreadHeadline('C1', 'Song (Charter)', ''),
    'C1 Song (Charter)',
  );
});
