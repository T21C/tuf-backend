import assert from 'node:assert/strict';
import test from 'node:test';
import {parseZenReportNote, ZEN_REPORT_NOTE_MAX} from './zenReportNote.js';

test('parseZenReportNote requires a non-empty note and trims it', () => {
  assert.equal(parseZenReportNote('  broken video  '), 'broken video');
  assert.throws(() => parseZenReportNote('   '), {status: 400, message: 'A note is required'});
  assert.throws(() => parseZenReportNote(undefined), {status: 400});
});

test('parseZenReportNote caps the note length', () => {
  const note = parseZenReportNote('n'.repeat(ZEN_REPORT_NOTE_MAX + 20));
  assert.equal(note.length, ZEN_REPORT_NOTE_MAX);
});
