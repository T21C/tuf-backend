import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lastNonEmptyComment,
  parseCurationSheetCsv,
  parseRecentIdList,
  selectCurationImportTargets,
  sheetRowIsDone,
} from './curationRatingImport.js';

test('parseCurationSheetCsv reads TUF id, comments, bulk, and done from the header row', () => {
  const csv = [
    'link,,TUF ID,Song,Comments,is rated?,Bulk',
    'x,,10,Song A,keep me,NEED RATING!!,TRUE',
    'x,,"20",Song B,,"Wow, this is done!",FALSE',
  ].join('\n');
  const rows = parseCurationSheetCsv(csv);
  assert.deepEqual(rows, [
    {levelId: 10, comments: 'keep me', bulk: true, isRated: 'NEED RATING!!'},
    {levelId: 20, comments: '', bulk: false, isRated: 'Wow, this is done!'},
  ]);
});

test('parseCurationSheetCsv keeps quoted newlines inside comments', () => {
  const csv = 'TUF ID,Comments,Bulk,is rated?\n11,"line one\nline two",FALSE,NEED RATING!!\n';
  const rows = parseCurationSheetCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.levelId, 11);
  assert.equal(rows[0]?.comments, 'line one\nline two');
});

test('parseRecentIdList keeps unique positive ids in file order', () => {
  assert.deepEqual(parseRecentIdList('16296\n14168\n16296\nabc\n703\n'), [16296, 14168, 703]);
  assert.deepEqual(parseRecentIdList('16296, 14168,16296 703'), [16296, 14168, 703]);
});

test('lastNonEmptyComment keeps the last filled cell', () => {
  assert.equal(lastNonEmptyComment(['first', '', 'second', '  ']), 'second');
  assert.equal(lastNonEmptyComment(['', '']), '');
});

test('sheetRowIsDone matches the checklist done mark', () => {
  assert.equal(sheetRowIsDone('Wow, this is done!'), true);
  assert.equal(sheetRowIsDone('NEED RATING!!'), false);
});

test('selectCurationImportTargets keeps overlap on Recent and skips done Bulk', () => {
  const {targets, skippedNoId, skippedDone} = selectCurationImportTargets({
    recentIds: [10, 20, 10],
    sheetRows: [
      {levelId: null, comments: '', bulk: false, isRated: ''},
      {levelId: 10, comments: 'keep me', bulk: true, isRated: 'NEED RATING!!'},
      {levelId: 10, comments: 'later reason', bulk: false, isRated: 'NEED RATING!!'},
      {levelId: 20, comments: '', bulk: false, isRated: 'Wow, this is done!'},
      {levelId: 30, comments: 'bulk reason', bulk: true, isRated: 'NEED RATING!!'},
      {levelId: 40, comments: 'done bulk', bulk: true, isRated: 'Wow, this is done!'},
      {levelId: 50, comments: 'not queued', bulk: false, isRated: 'NEED RATING!!'},
    ],
  });

  const byId = new Map(targets.map((row) => [row.levelId, row]));
  assert.equal(byId.get(10)?.flow, 'recent');
  assert.equal(byId.get(10)?.reason, 'later reason');
  assert.equal(byId.get(20)?.flow, 'recent');
  assert.equal(byId.get(30)?.flow, 'bulk');
  assert.equal(byId.get(30)?.reason, 'bulk reason');
  assert.equal(byId.has(40), false);
  assert.equal(byId.has(50), false);
  assert.equal(skippedNoId, 1);
  assert.equal(skippedDone, 1);
  assert.equal(targets.length, 3);
});
